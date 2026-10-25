#include "wifi_transport.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "controller.h"
#include "dhcpserver.h"
#include "lwip/ip.h"
#include "lwip/ip_addr.h"
#include "lwip/netif.h"
#include "lwip/pbuf.h"
#include "lwip/udp.h"
#include "mbedtls/md.h"
#include "packet.h"
#include "pico/cyw43_arch.h"
#include "pico/rand.h"
#include "pico/stdlib.h"
#include "provisioning.h"
#include "wifi_config.h"
#include "wifi_protocol.h"

#define ANNOUNCE_MS 2000
#define RSSI_MS 1000
#define CONNECT_TIMEOUT_MS 30000
#define RETRY_MS 5000
#define HELLO_PER_SEC 10
#define PING_PER_SEC 40
#define TEST_PER_SEC 10
#define DISCOVERY_PER_SEC 20

typedef enum {
	TRANSPORT_AP,
	TRANSPORT_STA_IDLE,
	TRANSPORT_STA_CONNECTING,
	TRANSPORT_STA_UP,
} transport_state_t;

static wifi_config_t *s_cfg;
static bool s_provision;
static transport_state_t s_state;
static struct udp_pcb *s_ctrl_pcb;
static struct udp_pcb *s_disc_pcb;
static dhcp_server_t s_dhcp;
static mbedtls_md_info_t const *s_md;

static char s_id_hex[17];
static char s_ip[16];
static int32_t s_rssi;

static uint32_t s_session;
static uint32_t s_tx_seq;
static uint32_t s_boot_id;
static uint32_t s_last_seq;
static uint64_t s_seq_window;

static uint32_t s_stat_rx;
static uint32_t s_stat_auth;
static uint32_t s_stat_dup;
static uint32_t s_stat_old;
static uint32_t s_stat_oow;
static uint32_t s_stat_bad;

static uint32_t s_retry_at;
static uint32_t s_connect_at;
static uint32_t s_announce_at;
static uint32_t s_rssi_at;
static uint8_t s_auth_index;

static uint32_t s_hello_window;
static uint32_t s_hello_count;
static uint32_t s_ping_window;
static uint32_t s_ping_count;
static uint32_t s_test_window;
static uint32_t s_test_count;
static uint32_t s_discovery_window;
static uint32_t s_discovery_count;

static uint32_t now_ms(void) {
	return to_ms_since_boot(get_absolute_time());
}

static uint16_t rd16(uint8_t const *p) {
	return (uint16_t)((uint16_t)p[0] | ((uint16_t)p[1] << 8));
}

static uint32_t rd32(uint8_t const *p) {
	return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static void wr16(uint8_t *p, uint16_t value) {
	p[0] = (uint8_t)value;
	p[1] = (uint8_t)(value >> 8);
}

static void wr32(uint8_t *p, uint32_t value) {
	p[0] = (uint8_t)value;
	p[1] = (uint8_t)(value >> 8);
	p[2] = (uint8_t)(value >> 16);
	p[3] = (uint8_t)(value >> 24);
}

static bool rate_allow(uint32_t *window, uint32_t *count, uint32_t max) {
	uint32_t now = now_ms();
	if ((int32_t)(now - *window) >= 1000) {
		*window = now;
		*count = 0;
	}
	if (*count >= max) return false;
	(*count)++;
	return true;
}

static bool mac_equal(uint8_t const *a, uint8_t const *b, size_t len) {
	uint8_t diff = 0;
	for (size_t i = 0; i < len; i++) diff |= (uint8_t)(a[i] ^ b[i]);
	return diff == 0;
}

static bool hmac_valid(uint8_t const *packet, uint16_t payload_len) {
	uint8_t input[S2PIPE_WIFI_PREFIX_LEN + S2PIPE_WIFI_PAYLOAD_MAX];
	uint8_t mac[32];
	if (payload_len > S2PIPE_WIFI_PAYLOAD_MAX) return false;
	memcpy(input, packet, S2PIPE_WIFI_PREFIX_LEN);
	if (payload_len) memcpy(input + S2PIPE_WIFI_PREFIX_LEN, packet + S2PIPE_WIFI_PAYLOAD_OFF, payload_len);
	if (mbedtls_md_hmac(s_md, s_cfg->psk, sizeof(s_cfg->psk), input, S2PIPE_WIFI_PREFIX_LEN + payload_len, mac) != 0) {
		return false;
	}
	return mac_equal(mac, packet + S2PIPE_WIFI_HMAC_OFF, S2PIPE_WIFI_HMAC_LEN);
}

static uint16_t build_packet(uint8_t *out, uint8_t type, uint32_t session, uint32_t seq, void const *payload, uint16_t payload_len) {
	uint8_t input[S2PIPE_WIFI_PREFIX_LEN + S2PIPE_WIFI_PAYLOAD_MAX];
	uint8_t mac[32];

	memset(out, 0, S2PIPE_WIFI_PAYLOAD_OFF);
	wr32(out, S2PIPE_WIFI_MAGIC);
	out[4] = S2PIPE_WIFI_VERSION;
	out[5] = type;
	wr32(out + 8, session);
	wr32(out + 12, seq);
	wr32(out + 16, now_ms());
	wr16(out + 20, payload_len);
	if (payload_len) memcpy(out + S2PIPE_WIFI_PAYLOAD_OFF, payload, payload_len);

	memcpy(input, out, S2PIPE_WIFI_PREFIX_LEN);
	if (payload_len) memcpy(input + S2PIPE_WIFI_PREFIX_LEN, payload, payload_len);
	mbedtls_md_hmac(s_md, s_cfg->psk, sizeof(s_cfg->psk), input, S2PIPE_WIFI_PREFIX_LEN + payload_len, mac);
	memcpy(out + S2PIPE_WIFI_HMAC_OFF, mac, S2PIPE_WIFI_HMAC_LEN);
	return (uint16_t)(S2PIPE_WIFI_PAYLOAD_OFF + payload_len);
}

static bool udp_send_raw(struct udp_pcb *pcb, uint8_t const *data, uint16_t len, ip_addr_t const *addr, uint16_t port) {
	if (!pcb || !data || !len) return false;
	struct pbuf *p = pbuf_alloc(PBUF_TRANSPORT, len, PBUF_RAM);
	if (!p) return false;
	pbuf_take(p, data, len);
	err_t err = udp_sendto(pcb, p, addr, port);
	pbuf_free(p);
	return err == ERR_OK;
}

static bool send_json(struct udp_pcb *pcb, uint8_t type, uint32_t session, char const *json, ip_addr_t const *addr, uint16_t port) {
	uint8_t packet[S2PIPE_WIFI_PACKET_MAX];
	size_t len = strlen(json);
	if (len > S2PIPE_WIFI_PAYLOAD_MAX) return false;
	uint16_t total = build_packet(packet, type, session, s_tx_seq++, json, (uint16_t)len);
	return udp_send_raw(pcb, packet, total, addr, port);
}

static bool send_raw_json(struct udp_pcb *pcb, char const *json, ip_addr_t const *addr, uint16_t port) {
	size_t len = strlen(json);
	if (len > S2PIPE_WIFI_PAYLOAD_MAX) return false;
	return udp_send_raw(pcb, (uint8_t const *)json, (uint16_t)len, addr, port);
}

static void update_ip(void) {
	if (s_state != TRANSPORT_STA_UP) {
		s_ip[0] = '\0';
		return;
	}
	struct netif *nif = &cyw43_state.netif[CYW43_ITF_STA];
	snprintf(s_ip, sizeof(s_ip), "%s", ip4addr_ntoa(netif_ip4_addr(nif)));
}

static void announce_json(char *out, size_t cap) {
	snprintf(
		out,
		cap,
		"{\"s2pipe\":1,\"type\":\"announce\",\"id\":\"%s\",\"name\":\"Pico 2 W\",\"ip\":\"%s\","
		"\"port\":%d,\"disc\":%d,\"fw\":\"%s\",\"rssi\":%ld,\"session\":%lu,\"boot\":%lu}",
		s_id_hex,
		s_ip,
		S2PIPE_WIFI_CONTROL_PORT,
		S2PIPE_WIFI_DISCOVERY_PORT,
		S2PIPE_WIFI_FW_VERSION,
		(long)s_rssi,
		(unsigned long)s_session,
		(unsigned long)s_boot_id
	);
}

static void announce_to(ip_addr_t const *addr, uint16_t port) {
	char json[240];
	announce_json(json, sizeof(json));
	send_raw_json(s_disc_pcb, json, addr, port);
}

static void announce_all(void) {
	char json[240];
	announce_json(json, sizeof(json));

	ip_addr_t all;
	IP_ADDR4(&all, 255, 255, 255, 255);
	send_raw_json(s_disc_pcb, json, &all, S2PIPE_WIFI_DISCOVERY_PORT);

	struct netif *nif = &cyw43_state.netif[CYW43_ITF_STA];
	ip4_addr_t const *ip = netif_ip4_addr(nif);
	ip4_addr_t const *mask = netif_ip4_netmask(nif);
	if (ip4_addr_get_u32(ip) != 0 && ip4_addr_get_u32(mask) != 0) {
		ip_addr_t subnet;
		ip4_addr_set_u32(&subnet, ip4_addr_get_u32(ip) | ~ip4_addr_get_u32(mask));
		send_raw_json(s_disc_pcb, json, &subnet, S2PIPE_WIFI_DISCOVERY_PORT);
	}
}

static bool seq_accept(uint32_t seq) {
	if (seq == 0) return false;
	if (s_last_seq == 0 || seq > s_last_seq) {
		uint32_t diff = s_last_seq == 0 ? 64 : seq - s_last_seq;
		if (diff >= 64) s_seq_window = 0;
		else s_seq_window <<= diff;
		s_seq_window |= 1;
		s_last_seq = seq;
		return true;
	}

	uint32_t diff = s_last_seq - seq;
	if (diff >= 64) {
		s_stat_old++;
		return false;
	}
	uint64_t bit = 1ull << diff;
	if (s_seq_window & bit) {
		s_stat_dup++;
		return false;
	}
	s_seq_window |= bit;
	s_stat_oow++;
	return true;
}

static void control_recv(void *arg, struct udp_pcb *pcb, struct pbuf *p, ip_addr_t const *addr, uint16_t port) {
	(void)arg;
	(void)pcb;
	uint8_t packet[S2PIPE_WIFI_PACKET_MAX];
	uint8_t const *payload;
	uint16_t payload_len;
	uint8_t type;
	uint32_t session;

	if (!p) return;
	if (p->tot_len < S2PIPE_WIFI_PAYLOAD_OFF || p->tot_len > S2PIPE_WIFI_PACKET_MAX) {
		pbuf_free(p);
		return;
	}

	uint16_t total = p->tot_len;
	pbuf_copy_partial(p, packet, total, 0);
	pbuf_free(p);

	if (rd32(packet) != S2PIPE_WIFI_MAGIC || packet[4] != S2PIPE_WIFI_VERSION) return;
	payload_len = rd16(packet + 20);
	if ((uint16_t)(S2PIPE_WIFI_PAYLOAD_OFF + payload_len) != total) return;
	if (!hmac_valid(packet, payload_len)) {
		s_stat_auth++;
		return;
	}

	type = packet[5];
	session = rd32(packet + 8);
	payload = packet + S2PIPE_WIFI_PAYLOAD_OFF;

	if (type == S2PIPE_WIFI_HELLO) {
		if (payload_len != 4 || !rate_allow(&s_hello_window, &s_hello_count, HELLO_PER_SEC)) return;
		uint32_t nonce = rd32(payload);

		s_session = get_rand_32();
		if (!s_session) s_session = 1;
		s_last_seq = 0;
		s_seq_window = 0;

		char json[240];
		snprintf(
			json,
			sizeof(json),
			"{\"nonce\":%lu,\"id\":\"%s\",\"ip\":\"%s\",\"port\":%d,\"fw\":\"%s\",\"rssi\":%ld,"
			"\"name\":\"Pico 2 W\",\"session\":%lu}",
			(unsigned long)nonce,
			s_id_hex,
			s_ip,
			S2PIPE_WIFI_CONTROL_PORT,
			S2PIPE_WIFI_FW_VERSION,
			(long)s_rssi,
			(unsigned long)s_session
		);
		send_json(s_ctrl_pcb, S2PIPE_WIFI_HELLO_ACK, s_session, json, addr, port);
		return;
	}

	if (session != s_session) {
		s_stat_auth++;
		return;
	}

	switch (type) {
		case S2PIPE_WIFI_CONTROL: {
			if (payload_len != PACKET_SIZE) {
				s_stat_bad++;
				return;
			}
			uint32_t seq = rd32(packet + 12);
			if (!seq_accept(seq)) return;
			/* Out-of-order packets are recorded for statistics, but an older
			   state must never overwrite the newest controller state. */
			if (seq != s_last_seq) return;
			if (controller_apply_frame(payload)) s_stat_rx++;
			else s_stat_bad++;
			return;
		}

		case S2PIPE_WIFI_PING: {
			if (payload_len != 4 || !rate_allow(&s_ping_window, &s_ping_count, PING_PER_SEC)) return;
			uint32_t nonce = rd32(payload);
			char json[240];
			snprintf(
				json,
				sizeof(json),
				"{\"nonce\":%lu,\"rssi\":%ld,\"rx\":%lu,\"auth\":%lu,\"dup\":%lu,\"old\":%lu,"
				"\"oow\":%lu,\"bad\":%lu,\"up\":%lu}",
				(unsigned long)nonce,
				(long)s_rssi,
				(unsigned long)s_stat_rx,
				(unsigned long)s_stat_auth,
				(unsigned long)s_stat_dup,
				(unsigned long)s_stat_old,
				(unsigned long)s_stat_oow,
				(unsigned long)s_stat_bad,
				(unsigned long)(now_ms() / 1000)
			);
			send_json(s_ctrl_pcb, S2PIPE_WIFI_PONG, s_session, json, addr, port);
			return;
		}

		case S2PIPE_WIFI_TEST: {
			if (payload_len != 5 || !rate_allow(&s_test_window, &s_test_count, TEST_PER_SEC)) return;
			uint8_t index = payload[0];
			if (index >= PAD_COUNT) return;
			pad_state_t state = {
				.buttons = (uint32_t)rd16(payload + 1) & 0x3fffu,
				.lx = PAD_CENTER,
				.ly = PAD_CENTER,
				.rx = PAD_CENTER,
				.ry = PAD_CENTER,
			};
			controller_test_state(index, &state, rd16(payload + 3));
			return;
		}

		default:
			return;
	}
}

static void discovery_recv(void *arg, struct udp_pcb *pcb, struct pbuf *p, ip_addr_t const *addr, uint16_t port) {
	(void)arg;
	(void)pcb;
	if (!p) return;

	char buf[128];
	uint16_t len = p->tot_len < sizeof(buf) - 1 ? p->tot_len : sizeof(buf) - 1;
	pbuf_copy_partial(p, buf, len, 0);
	buf[len] = '\0';
	pbuf_free(p);

	if (!strstr(buf, "\"s2pipe\"") || !strstr(buf, "\"discover\"")) return;
	if (!rate_allow(&s_discovery_window, &s_discovery_count, DISCOVERY_PER_SEC)) return;
	announce_to(addr, port);
}

static void create_udp(struct netif *nif) {
	s_ctrl_pcb = udp_new();
	if (s_ctrl_pcb) {
		udp_bind(s_ctrl_pcb, IP_ANY_TYPE, S2PIPE_WIFI_CONTROL_PORT);
		if (nif) udp_bind_netif(s_ctrl_pcb, nif);
		udp_recv(s_ctrl_pcb, control_recv, NULL);
	}

	s_disc_pcb = udp_new();
	if (s_disc_pcb) {
		udp_bind(s_disc_pcb, IP_ANY_TYPE, S2PIPE_WIFI_DISCOVERY_PORT);
		if (nif) udp_bind_netif(s_disc_pcb, nif);
		udp_recv(s_disc_pcb, discovery_recv, NULL);
		ip_set_option(s_disc_pcb, SOF_BROADCAST);
	}
}

bool wifi_transport_platform_init(void) {
	s_md = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
	if (!s_md) return false;
	return cyw43_arch_init() == 0;
}

void wifi_transport_start(wifi_config_t *cfg, bool provision) {
	s_cfg = cfg;
	s_provision = provision;
	s_state = provision ? TRANSPORT_AP : TRANSPORT_STA_IDLE;
	wifi_config_device_id_hex(cfg, s_id_hex);

	s_session = get_rand_32();
	if (!s_session) s_session = 1;
	s_boot_id = get_rand_32();
	s_tx_seq = 1;
	s_rssi = 0;
	s_ip[0] = '\0';

	if (provision) {
		cyw43_arch_enable_ap_mode(cfg->setup_ssid, cfg->setup_pass, CYW43_AUTH_WPA2_AES_PSK);
		cyw43_wifi_pm(&cyw43_state, CYW43_NONE_PM);

		ip4_addr_t ip;
		ip4_addr_t mask;
		IP4_ADDR(&ip, 192, 168, 4, 1);
		IP4_ADDR(&mask, 255, 255, 255, 0);
		dhcp_server_init(&s_dhcp, &cyw43_state.netif[CYW43_ITF_AP], &ip, &mask);
		/* lwIP is built with IP_SOF_BROADCAST(_RECV)=1, so the DHCP server
		   must opt in to receive the client's 255.255.255.255 DISCOVER and
		   send broadcast OFFER/ACK replies. */
		if (s_dhcp.udp) ip_set_option(s_dhcp.udp, SOF_BROADCAST);
		snprintf(s_ip, sizeof(s_ip), "192.168.4.1");

		create_udp(&cyw43_state.netif[CYW43_ITF_AP]);
		provisioning_start(cfg);
	} else {
		cyw43_arch_enable_sta_mode();
		cyw43_wifi_pm(&cyw43_state, CYW43_NONE_PM);
		create_udp(&cyw43_state.netif[CYW43_ITF_STA]);
	}
}

static void sta_poll(void) {
	uint32_t now = now_ms();

	if (s_state == TRANSPORT_STA_IDLE) {
		if ((int32_t)(now - s_retry_at) < 0) return;
		static uint32_t const auth_modes[] = {
			CYW43_AUTH_WPA2_AES_PSK,
			CYW43_AUTH_WPA3_WPA2_AES_PSK,
			CYW43_AUTH_WPA3_SAE_AES_PSK,
		};
		uint32_t auth = CYW43_AUTH_OPEN;
		char const *pass = NULL;
		if (s_cfg->pass[0]) {
			pass = s_cfg->pass;
			auth = auth_modes[s_auth_index % 3];
		}
		if (cyw43_arch_wifi_connect_async(s_cfg->ssid, pass, auth) == 0) {
			s_state = TRANSPORT_STA_CONNECTING;
			s_connect_at = now;
		} else {
			s_retry_at = now + RETRY_MS;
		}
		return;
	}

	if (s_state == TRANSPORT_STA_CONNECTING) {
		int status = cyw43_tcpip_link_status(&cyw43_state, CYW43_ITF_STA);
		if (status == CYW43_LINK_UP) {
			s_state = TRANSPORT_STA_UP;
			s_announce_at = 0;
			s_rssi_at = 0;
			update_ip();
			return;
		}
		if (status < 0) {
			if (status == CYW43_LINK_BADAUTH) s_auth_index = (uint8_t)((s_auth_index + 1) % 3);
			cyw43_wifi_leave(&cyw43_state, CYW43_ITF_STA);
			s_state = TRANSPORT_STA_IDLE;
			s_retry_at = now + RETRY_MS;
			return;
		}
		if ((int32_t)(now - s_connect_at) > CONNECT_TIMEOUT_MS) {
			cyw43_wifi_leave(&cyw43_state, CYW43_ITF_STA);
			s_state = TRANSPORT_STA_IDLE;
			s_retry_at = now + RETRY_MS;
		}
		return;
	}

	if (s_state != TRANSPORT_STA_UP) return;
	if (cyw43_tcpip_link_status(&cyw43_state, CYW43_ITF_STA) != CYW43_LINK_UP) {
		s_state = TRANSPORT_STA_IDLE;
		s_retry_at = now + 2000;
		s_ip[0] = '\0';
		return;
	}

	if ((int32_t)(now - s_rssi_at) >= 0) {
		s_rssi_at = now + RSSI_MS;
		int32_t rssi = 0;
		if (cyw43_wifi_get_rssi(&cyw43_state, &rssi) == 0) s_rssi = rssi;
	}
	if ((int32_t)(now - s_announce_at) >= 0) {
		s_announce_at = now + ANNOUNCE_MS;
		announce_all();
	}
}

void wifi_transport_poll(void) {
	cyw43_arch_poll();
	if (s_provision) return;
	sta_poll();
}

bool wifi_transport_is_connected(void) {
	return s_state == TRANSPORT_STA_UP;
}

bool wifi_transport_is_provisioning(void) {
	return s_provision;
}

int32_t wifi_transport_rssi(void) {
	return s_rssi;
}

char const *wifi_transport_ip(void) {
	return s_ip;
}

uint32_t wifi_transport_dhcp_leases(void) {
	uint32_t count = 0;
	for (int i = 0; i < DHCPS_MAX_IP; i++) {
		uint8_t const *mac = s_dhcp.lease[i].mac;
		if (mac[0] | mac[1] | mac[2] | mac[3] | mac[4] | mac[5]) count++;
	}
	return count;
}
