#ifndef WIFI_CONFIG_H
#define WIFI_CONFIG_H

#include <stdbool.h>
#include <stdint.h>

#define WIFI_CONFIG_MAGIC 0x53325746u /* "S2WF" */
#define WIFI_CONFIG_VERSION 1
#define WIFI_CONFIG_RECORD_SIZE 256
#define WIFI_CONFIG_FLAG_NETWORK 0x0001u

/* Two slots at the end of flash. A slot is erased and rewritten only when the
   user saves or resets provisioning, so flash wear stays negligible. */
typedef struct __attribute__((packed)) {
	uint32_t magic;
	uint16_t version;
	uint16_t flags;
	uint32_t seq;
	uint8_t device_id[8];
	char ssid[33];
	char pass[65];
	uint8_t psk[32];
	char setup_ssid[33];
	char setup_pass[17];
	uint8_t reserved[52];
	uint32_t crc;
} wifi_config_t;

_Static_assert(sizeof(wifi_config_t) == WIFI_CONFIG_RECORD_SIZE, "wifi config record must be one flash page");

bool wifi_config_load(wifi_config_t *cfg);
bool wifi_config_save(wifi_config_t *cfg);
bool wifi_config_has_network(wifi_config_t const *cfg);
void wifi_config_init_defaults(wifi_config_t *cfg);
void wifi_config_set_network(wifi_config_t *cfg, char const *ssid, char const *pass);
void wifi_config_clear_network(wifi_config_t *cfg);
void wifi_config_device_id_hex(wifi_config_t const *cfg, char out[17]);
void wifi_config_psk_hex(wifi_config_t const *cfg, char out[65]);

#endif
