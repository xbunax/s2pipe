#include "wifi_config.h"

#include <stddef.h>
#include <stdio.h>
#include <string.h>

#include "hardware/flash.h"
#include "hardware/regs/addressmap.h"
#include "pico/flash.h"
#include "pico/rand.h"
#include "pico/unique_id.h"

#ifndef PICO_FLASH_SIZE_BYTES
#error "PICO_FLASH_SIZE_BYTES is required for the Wi-Fi config sector"
#endif

#define CONFIG_SLOT_A (PICO_FLASH_SIZE_BYTES - 2u * FLASH_SECTOR_SIZE)
#define CONFIG_SLOT_B (PICO_FLASH_SIZE_BYTES - 1u * FLASH_SECTOR_SIZE)

static char const setup_chars[] = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

static uint32_t crc32_bytes(uint8_t const *data, size_t len) {
	uint32_t crc = 0xffffffffu;
	for (size_t i = 0; i < len; i++) {
		crc ^= data[i];
		for (int bit = 0; bit < 8; bit++) {
			crc = (crc >> 1) ^ (0xedb88320u & (uint32_t)-(int32_t)(crc & 1u));
		}
	}
	return ~crc;
}

static void random_bytes(uint8_t *out, size_t len) {
	for (size_t i = 0; i < len; i += 4) {
		uint32_t value = get_rand_32();
		size_t chunk = len - i < 4 ? len - i : 4;
		memcpy(out + i, &value, chunk);
	}
}

static void generate_setup_pass(char out[17]) {
	for (int i = 0; i < 12; i++) {
		out[i] = setup_chars[get_rand_32() & 31u];
	}
	out[12] = '\0';
}

static void make_setup_ssid(wifi_config_t *cfg) {
	char hex[17];
	wifi_config_device_id_hex(cfg, hex);
	snprintf(cfg->setup_ssid, sizeof(cfg->setup_ssid), "S2PIPE-%s", hex + 8);
}

static bool record_valid(uint8_t const *raw, wifi_config_t *out) {
	wifi_config_t tmp;
	memcpy(&tmp, raw, sizeof(tmp));
	if (tmp.magic != WIFI_CONFIG_MAGIC || tmp.version != WIFI_CONFIG_VERSION) return false;
	if (tmp.crc != crc32_bytes(raw, offsetof(wifi_config_t, crc))) return false;
	tmp.ssid[sizeof(tmp.ssid) - 1] = '\0';
	tmp.pass[sizeof(tmp.pass) - 1] = '\0';
	tmp.setup_ssid[sizeof(tmp.setup_ssid) - 1] = '\0';
	tmp.setup_pass[sizeof(tmp.setup_pass) - 1] = '\0';
	if (out) *out = tmp;
	return true;
}

void wifi_config_init_defaults(wifi_config_t *cfg) {
	memset(cfg, 0, sizeof(*cfg));
	cfg->magic = WIFI_CONFIG_MAGIC;
	cfg->version = WIFI_CONFIG_VERSION;

	pico_unique_board_id_t id;
	pico_get_unique_board_id(&id);
	memcpy(cfg->device_id, id.id, sizeof(cfg->device_id));

	generate_setup_pass(cfg->setup_pass);
	random_bytes(cfg->psk, sizeof(cfg->psk));
	if (!(cfg->psk[0] | cfg->psk[1] | cfg->psk[2] | cfg->psk[3])) cfg->psk[0] = 1;
	make_setup_ssid(cfg);
}

bool wifi_config_load(wifi_config_t *cfg) {
	uint8_t const *raw_a = (uint8_t const *)(XIP_BASE + CONFIG_SLOT_A);
	uint8_t const *raw_b = (uint8_t const *)(XIP_BASE + CONFIG_SLOT_B);
	wifi_config_t a, b;
	bool ok_a = record_valid(raw_a, &a);
	bool ok_b = record_valid(raw_b, &b);

	if (ok_a && ok_b) {
		*cfg = a.seq >= b.seq ? a : b;
	} else if (ok_a) {
		*cfg = a;
	} else if (ok_b) {
		*cfg = b;
	} else {
		wifi_config_init_defaults(cfg);
		wifi_config_save(cfg);
		return false;
	}

	/* Repair records from older firmware that predate a generated field. */
	bool changed = false;
	if (!cfg->setup_ssid[0]) {
		make_setup_ssid(cfg);
		changed = true;
	}
	if (!cfg->setup_pass[0]) {
		generate_setup_pass(cfg->setup_pass);
		changed = true;
	}
	if (!(cfg->psk[0] | cfg->psk[1] | cfg->psk[2] | cfg->psk[3])) {
		random_bytes(cfg->psk, sizeof(cfg->psk));
		cfg->psk[0] |= 1;
		changed = true;
	}
	if (changed) wifi_config_save(cfg);
	return true;
}

typedef struct {
	uint32_t offset;
	uint8_t const *data;
} flash_job_t;

static void flash_job(void *param) {
	flash_job_t const *job = (flash_job_t const *)param;
	flash_range_erase(job->offset, FLASH_SECTOR_SIZE);
	flash_range_program(job->offset, job->data, WIFI_CONFIG_RECORD_SIZE);
}

bool wifi_config_save(wifi_config_t *cfg) {
	uint8_t const *raw_a = (uint8_t const *)(XIP_BASE + CONFIG_SLOT_A);
	uint8_t const *raw_b = (uint8_t const *)(XIP_BASE + CONFIG_SLOT_B);
	wifi_config_t a, b;
	bool ok_a = record_valid(raw_a, &a);
	bool ok_b = record_valid(raw_b, &b);

	uint32_t next = 1;
	uint32_t offset = CONFIG_SLOT_A;
	if (ok_a && ok_b) {
		next = (a.seq > b.seq ? a.seq : b.seq) + 1;
		offset = a.seq <= b.seq ? CONFIG_SLOT_A : CONFIG_SLOT_B;
	} else if (ok_a) {
		next = a.seq + 1;
		offset = CONFIG_SLOT_B;
	} else if (ok_b) {
		next = b.seq + 1;
		offset = CONFIG_SLOT_A;
	}

	cfg->magic = WIFI_CONFIG_MAGIC;
	cfg->version = WIFI_CONFIG_VERSION;
	cfg->seq = next;
	cfg->crc = crc32_bytes((uint8_t const *)cfg, offsetof(wifi_config_t, crc));

	static uint8_t flash_buf[WIFI_CONFIG_RECORD_SIZE];
	memcpy(flash_buf, cfg, sizeof(*cfg));
	memset(flash_buf + sizeof(*cfg), 0, sizeof(flash_buf) - sizeof(*cfg));

	flash_job_t job = { .offset = offset, .data = flash_buf };
	return flash_safe_execute(flash_job, &job, 1000) == PICO_OK;
}

bool wifi_config_has_network(wifi_config_t const *cfg) {
	return (cfg->flags & WIFI_CONFIG_FLAG_NETWORK) != 0 && cfg->ssid[0] != '\0';
}

void wifi_config_set_network(wifi_config_t *cfg, char const *ssid, char const *pass) {
	snprintf(cfg->ssid, sizeof(cfg->ssid), "%s", ssid);
	snprintf(cfg->pass, sizeof(cfg->pass), "%s", pass);
	cfg->flags |= WIFI_CONFIG_FLAG_NETWORK;
}

void wifi_config_clear_network(wifi_config_t *cfg) {
	cfg->flags &= (uint16_t)~WIFI_CONFIG_FLAG_NETWORK;
	cfg->ssid[0] = '\0';
	cfg->pass[0] = '\0';
	generate_setup_pass(cfg->setup_pass);
	random_bytes(cfg->psk, sizeof(cfg->psk));
	if (!(cfg->psk[0] | cfg->psk[1] | cfg->psk[2] | cfg->psk[3])) cfg->psk[0] = 1;
	make_setup_ssid(cfg);
}

void wifi_config_device_id_hex(wifi_config_t const *cfg, char out[17]) {
	static char const hex[] = "0123456789abcdef";
	for (int i = 0; i < 8; i++) {
		out[i * 2] = hex[cfg->device_id[i] >> 4];
		out[i * 2 + 1] = hex[cfg->device_id[i] & 0x0f];
	}
	out[16] = '\0';
}

void wifi_config_psk_hex(wifi_config_t const *cfg, char out[65]) {
	static char const hex[] = "0123456789abcdef";
	for (int i = 0; i < 32; i++) {
		out[i * 2] = hex[cfg->psk[i] >> 4];
		out[i * 2 + 1] = hex[cfg->psk[i] & 0x0f];
	}
	out[64] = '\0';
}
