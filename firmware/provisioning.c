#include "provisioning.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "hardware/watchdog.h"
#include "lwip/ip_addr.h"
#include "lwip/tcp.h"
#include "pico/bootrom.h"
#include "pico/cyw43_arch.h"
#include "pico/stdlib.h"
#include "tusb.h"

#include "wifi_protocol.h"
#include "wifi_transport.h"

#define HTTP_BUF_SIZE 1024
#define HTTP_RESPONSE_HEAD 256

typedef struct {
	struct tcp_pcb *pcb;
	char *buf;
	uint16_t len;
	uint16_t cap;
	bool handled;
	uint32_t close_at;
} http_conn_t;

static wifi_config_t *s_cfg;
static struct tcp_pcb *s_listen;
static uint32_t s_reboot_at;
static uint32_t s_http_requests;

static uint32_t now_ms(void) {
	return to_ms_since_boot(get_absolute_time());
}

static void conn_free(http_conn_t *conn) {
	if (!conn) return;
	free(conn->buf);
	free(conn);
}

static void conn_close(http_conn_t *conn) {
	if (!conn) return;
	if (conn->pcb) {
		tcp_arg(conn->pcb, NULL);
		tcp_recv(conn->pcb, NULL);
		tcp_err(conn->pcb, NULL);
		tcp_poll(conn->pcb, NULL, 0);
		if (tcp_close(conn->pcb) != ERR_OK) tcp_abort(conn->pcb);
		conn->pcb = NULL;
	}
	conn_free(conn);
}

static void http_err(void *arg, err_t err) {
	(void)err;
	http_conn_t *conn = (http_conn_t *)arg;
	if (!conn) return;
	conn->pcb = NULL;
	conn_free(conn);
}

static err_t http_poll(void *arg, struct tcp_pcb *pcb) {
	(void)pcb;
	http_conn_t *conn = (http_conn_t *)arg;
	if (conn && conn->close_at && (int32_t)(now_ms() - conn->close_at) >= 0) {
		conn_close(conn);
	}
	return ERR_OK;
}

static void http_send(http_conn_t *conn, char const *status, char const *type, char const *body, size_t body_len) {
	if (!conn || !conn->pcb || conn->handled) return;
	conn->handled = true;

	char head[HTTP_RESPONSE_HEAD];
	int head_len = snprintf(
		head,
		sizeof(head),
		"HTTP/1.1 %s\r\n"
		"Content-Type: %s\r\n"
		"Content-Length: %u\r\n"
		"Connection: close\r\n"
		"Cache-Control: no-store\r\n"
		"\r\n",
		status,
		type,
		(unsigned)body_len
	);
	if (head_len <= 0 || head_len >= (int)sizeof(head)) {
		conn_close(conn);
		return;
	}

	size_t total = (size_t)head_len + body_len;
	char *response = (char *)malloc(total);
	if (!response) {
		conn_close(conn);
		return;
	}
	memcpy(response, head, (size_t)head_len);
	memcpy(response + head_len, body, body_len);

	err_t err = tcp_write(conn->pcb, response, (uint16_t)total, TCP_WRITE_FLAG_COPY);
	free(response);
	if (err == ERR_OK) {
		tcp_output(conn->pcb);
		conn->close_at = now_ms() + 1000;
	} else {
		conn_close(conn);
	}
}

static int hex_value(char c) {
	if (c >= '0' && c <= '9') return c - '0';
	if (c >= 'a' && c <= 'f') return c - 'a' + 10;
	if (c >= 'A' && c <= 'F') return c - 'A' + 10;
	return -1;
}

static void url_decode(char const *src, char *dst, size_t cap) {
	size_t out = 0;
	while (*src && *src != '&' && out + 1 < cap) {
		char c = *src++;
		if (c == '+') {
			c = ' ';
		} else if (c == '%' && src[0] && src[1]) {
			int hi = hex_value(src[0]);
			int lo = hex_value(src[1]);
			if (hi >= 0 && lo >= 0) {
				c = (char)((hi << 4) | lo);
				src += 2;
			}
		}
		dst[out++] = c;
	}
	dst[out] = '\0';
}

static bool form_field(char const *body, char const *key, char *out, size_t cap) {
	size_t key_len = strlen(key);
	char const *p = body;
	while (p && *p) {
		if (strncmp(p, key, key_len) == 0 && p[key_len] == '=') {
			url_decode(p + key_len + 1, out, cap);
			return true;
		}
		p = strchr(p, '&');
		if (p) p++;
	}
	return false;
}

static char const form_page[] =
	"<!doctype html><html><head><meta charset=utf-8>"
	"<meta name=viewport content=\"width=device-width,initial-scale=1\">"
	"<title>s2pipe Wi-Fi setup</title>"
	"<style>body{font:16px system-ui,sans-serif;background:#07080a;color:#e9eef5;margin:0;padding:24px}"
	"main{max-width:440px;margin:auto}h1{font-size:1.35rem;margin:0 0 4px}p{color:#9aa7b8;line-height:1.45}"
	"label{display:block;margin:18px 0 6px;color:#c9d4e2}input{box-sizing:border-box;width:100%;padding:12px;"
	"border:1px solid #2a3442;border-radius:10px;background:#11161d;color:#fff;font-size:16px}"
	"button{margin-top:20px;width:100%;padding:13px;border:0;border-radius:10px;background:#3ee6a0;color:#04110a;"
	"font-weight:700;font-size:16px}code{word-break:break-all;color:#3ee6a0}.note{font-size:13px;margin-top:22px}"
	"</style></head><body><main>"
	"<h1>s2pipe Wi-Fi setup</h1>"
	"<p>Enter the 2.4 GHz Wi-Fi network the Pico should join. The Pico only supports 2.4 GHz.</p>"
	"<form method=post action=/save>"
	"<label for=ssid>Wi-Fi name (SSID)</label>"
	"<input id=ssid name=ssid maxlength=32 autocomplete=off autocapitalize=off required>"
	"<label for=password>Wi-Fi password</label>"
	"<input id=password name=password type=password maxlength=63 autocomplete=new-password>"
	"<button type=submit>Save and reboot</button></form>"
	"<p class=note>Device <code>%s</code><br>Setup hotspot <code>%s</code><br>Pairing key <code>%s</code></p>"
	"<p class=note>If the Pico cannot join the network, hold the BOOTSEL button for 5 seconds while it is "
	"powered to erase the Wi-Fi settings and start this hotspot again.</p>"
	"</main></body></html>";

static char const done_page[] =
	"<!doctype html><html><head><meta charset=utf-8>"
	"<meta name=viewport content=\"width=device-width,initial-scale=1\">"
	"<title>Saved</title><style>body{font:16px system-ui,sans-serif;background:#07080a;color:#e9eef5;"
	"margin:0;padding:24px}main{max-width:440px;margin:auto}h1{font-size:1.35rem;color:#3ee6a0}"
	"p{color:#9aa7b8;line-height:1.45}code{word-break:break-all;color:#3ee6a0}</style></head><body><main>"
	"<h1>Saved</h1><p>The Pico is rebooting and will join <strong>%s</strong>.</p>"
	"<p>Pairing key for the s2pipe launcher:</p><p><code>%s</code></p>"
	"<p>The launcher can also read this key over USB. If the Pico does not appear on the network, hold "
	"BOOTSEL for 5 seconds while it is powered to reset Wi-Fi.</p></main></body></html>";

static void handle_request(http_conn_t *conn) {
	char method[8];
	char path[80];
	if (sscanf(conn->buf, "%7s %79s", method, path) != 2) {
		http_send(conn, "400 Bad Request", "text/plain", "bad request\n", 12);
		return;
	}

	char *header_end = strstr(conn->buf, "\r\n\r\n");
	if (!header_end) {
		http_send(conn, "400 Bad Request", "text/plain", "bad request\n", 12);
		return;
	}

	if (strcmp(method, "GET") == 0 && strcmp(path, "/") == 0) {
		char id[17];
		char psk[65];
		wifi_config_device_id_hex(s_cfg, id);
		wifi_config_psk_hex(s_cfg, psk);
		static char body[4096];
		int len = snprintf(
			body,
			sizeof(body),
			form_page,
			id,
			s_cfg->setup_ssid,
			psk
		);
		if (len <= 0 || len >= (int)sizeof(body)) {
			http_send(conn, "500 Internal Server Error", "text/plain", "page too large\n", 15);
			return;
		}
		http_send(conn, "200 OK", "text/html; charset=utf-8", body, (size_t)len);
		return;
	}

	if (strcmp(method, "GET") == 0 && strcmp(path, "/status") == 0) {
		char id[17];
		wifi_config_device_id_hex(s_cfg, id);
		static char body[256];
		int len = snprintf(
			body,
			sizeof(body),
			"{\"s2pipe\":1,\"mode\":\"ap\",\"id\":\"%s\",\"ap\":\"%s\",\"fw\":\"%s\"}",
			id,
			s_cfg->setup_ssid,
			S2PIPE_WIFI_FW_VERSION
		);
		http_send(conn, "200 OK", "application/json", body, (size_t)len);
		return;
	}

	if (strcmp(method, "POST") == 0 && strcmp(path, "/save") == 0) {
		char *body = header_end + 4;
		size_t received = (size_t)(conn->buf + conn->len - body);
		char *length_header = strstr(conn->buf, "Content-Length:");
		if (!length_header) length_header = strstr(conn->buf, "content-length:");
		int content_length = length_header ? atoi(length_header + 15) : -1;
		if (content_length < 0 || content_length > 512) {
			http_send(conn, "413 Payload Too Large", "text/plain", "bad form\n", 9);
			return;
		}
		if (received < (size_t)content_length) {
			/* The browser may send the body in a second TCP segment. */
			conn->handled = false;
			return;
		}
		body[content_length] = '\0';

		char ssid[33];
		char pass[65];
		if (!form_field(body, "ssid", ssid, sizeof(ssid))) {
			http_send(conn, "400 Bad Request", "text/plain", "missing ssid\n", 13);
			return;
		}
		if (!form_field(body, "password", pass, sizeof(pass))) pass[0] = '\0';
		size_t ssid_len = strlen(ssid);
		size_t pass_len = strlen(pass);
		if (ssid_len < 1 || ssid_len > 32 || (pass_len != 0 && (pass_len < 8 || pass_len > 63))) {
			http_send(conn, "400 Bad Request", "text/plain", "invalid credentials\n", 20);
			return;
		}

		wifi_config_set_network(s_cfg, ssid, pass);
		bool saved = wifi_config_save(s_cfg);
		if (!saved) {
			http_send(conn, "500 Internal Server Error", "text/plain", "flash write failed\n", 19);
			return;
		}

		char psk[65];
		wifi_config_psk_hex(s_cfg, psk);
		static char done[1024];
		int len = snprintf(done, sizeof(done), done_page, ssid, psk);
		http_send(conn, "200 OK", "text/html; charset=utf-8", done, (size_t)len);
		s_reboot_at = now_ms() + 3000;
		return;
	}

	http_send(conn, "404 Not Found", "text/plain", "not found\n", 10);
}

static err_t http_recv(void *arg, struct tcp_pcb *pcb, struct pbuf *p, err_t err) {
	http_conn_t *conn = (http_conn_t *)arg;
	if (err != ERR_OK) {
		if (p) pbuf_free(p);
		conn_close(conn);
		return ERR_ABRT;
	}
	if (!p) {
		conn_close(conn);
		return ERR_OK;
	}
	if (!conn) {
		pbuf_free(p);
		return ERR_ABRT;
	}
	if (conn->handled || conn->len + p->tot_len > conn->cap - 1) {
		pbuf_free(p);
		conn_close(conn);
		return ERR_ABRT;
	}

	pbuf_copy_partial(p, conn->buf + conn->len, p->tot_len, 0);
	conn->len = (uint16_t)(conn->len + p->tot_len);
	conn->buf[conn->len] = '\0';
	tcp_recved(pcb, p->tot_len);
	pbuf_free(p);

	if (!strstr(conn->buf, "\r\n\r\n")) {
		if (conn->len + 1 >= conn->cap) conn_close(conn);
		return ERR_OK;
	}

	handle_request(conn);
	return ERR_OK;
}

static err_t http_accept(void *arg, struct tcp_pcb *pcb, err_t err) {
	(void)arg;
	if (err != ERR_OK || !pcb) return ERR_VAL;
	s_http_requests++;

	http_conn_t *conn = (http_conn_t *)calloc(1, sizeof(http_conn_t));
	if (!conn) return ERR_MEM;
	conn->buf = (char *)calloc(1, HTTP_BUF_SIZE + 1);
	if (!conn->buf) {
		free(conn);
		return ERR_MEM;
	}
	conn->cap = HTTP_BUF_SIZE;
	conn->pcb = pcb;

	tcp_setprio(pcb, TCP_PRIO_MIN);
	tcp_arg(pcb, conn);
	tcp_recv(pcb, http_recv);
	tcp_err(pcb, http_err);
	tcp_poll(pcb, http_poll, 2);
	return ERR_OK;
}

void provisioning_start(wifi_config_t *cfg) {
	s_cfg = cfg;
	s_reboot_at = 0;

	cyw43_arch_lwip_begin();
	struct tcp_pcb *pcb = tcp_new_ip_type(IPADDR_TYPE_ANY);
	if (!pcb) {
		cyw43_arch_lwip_end();
		return;
	}
	err_t err = tcp_bind(pcb, IP_ADDR_ANY, 80);
	if (err != ERR_OK) {
		tcp_close(pcb);
		cyw43_arch_lwip_end();
		return;
	}
	s_listen = tcp_listen_with_backlog(pcb, 2);
	if (!s_listen) {
		tcp_close(pcb);
		cyw43_arch_lwip_end();
		return;
	}
	tcp_accept(s_listen, http_accept);
	cyw43_arch_lwip_end();
}

static void cdc_commands(wifi_config_t *cfg) {
	static char line[320];
	static size_t len;

	while (tud_cdc_available()) {
		int c = tud_cdc_read_char();
		if (c < 0) break;
		if (c == '\r' || c == '\n') {
			line[len] = '\0';
			if (strcmp(line, "S2PIPE-BOOT") == 0) {
				reset_usb_boot(0, 0);
			} else if (strcmp(line, "S2PIPE-REBOOT") == 0) {
				watchdog_reboot(0, 0, 100);
			} else if (strncmp(line, "S2PIPE-PROV ", 12) == 0) {
				char ssid[33] = { 0 };
				char pass[65] = { 0 };
				char const *body = line + 12;
				bool have_ssid = form_field(body, "ssid", ssid, sizeof(ssid));
				bool have_pass = form_field(body, "pass", pass, sizeof(pass));
				size_t ssid_len = strlen(ssid);
				size_t pass_len = strlen(pass);

				if (
					!have_ssid || ssid_len < 1 || ssid_len > 32 ||
					(pass_len != 0 && (pass_len < 8 || pass_len > 63))
				) {
					tud_cdc_write_str("S2PIPE-PROV-ERR invalid\r\n");
					tud_cdc_write_flush();
				} else {
					(void)have_pass;
					wifi_config_set_network(cfg, ssid, pass);
					if (wifi_config_save(cfg)) {
						tud_cdc_write_str("S2PIPE-PROV-OK\r\n");
						tud_cdc_write_flush();
						s_reboot_at = now_ms() + 1500;
					} else {
						tud_cdc_write_str("S2PIPE-PROV-ERR flash\r\n");
						tud_cdc_write_flush();
					}
				}
				memset(ssid, 0, sizeof(ssid));
				memset(pass, 0, sizeof(pass));
			}
			memset(line, 0, sizeof(line));
			len = 0;
		} else if (len + 1 < sizeof(line)) {
			line[len++] = (char)c;
		}
	}
}

void provisioning_poll(wifi_config_t *cfg, bool provision) {
	uint32_t now = now_ms();
	if (s_reboot_at && (int32_t)(now - s_reboot_at) >= 0) {
		watchdog_reboot(0, 0, 100);
	}

	cdc_commands(cfg);

	static uint32_t next_line;
	if ((int32_t)(now - next_line) < 0) return;
	next_line = now + (provision ? 1000 : 5000);

	if (!tud_cdc_connected()) return;

	char id[17];
	char psk[65];
	char ip[16];
	wifi_config_device_id_hex(cfg, id);
	wifi_config_psk_hex(cfg, psk);
	snprintf(ip, sizeof(ip), "%s", wifi_transport_ip());

	char line[320];
	int len;
	if (provision) {
		len = snprintf(
			line,
			sizeof(line),
			"S2PIPE-SETUP {\"id\":\"%s\",\"ssid\":\"%s\",\"pass\":\"%s\",\"psk\":\"%s\",\"fw\":\"%s\",\"mode\":\"ap\",\"ip\":\"%s\",\"leases\":%lu,\"http\":%lu}\r\n",
			id,
			cfg->setup_ssid,
			cfg->setup_pass,
			psk,
			S2PIPE_WIFI_FW_VERSION,
			ip,
			(unsigned long)wifi_transport_dhcp_leases(),
			(unsigned long)s_http_requests
		);
	} else {
		len = snprintf(
			line,
			sizeof(line),
			"S2PIPE-STATUS {\"id\":\"%s\",\"ip\":\"%s\",\"rssi\":%ld,\"fw\":\"%s\",\"mode\":\"sta\"}\r\n",
			id,
			ip,
			(long)wifi_transport_rssi(),
			S2PIPE_WIFI_FW_VERSION
		);
	}
	if (len <= 0 || len >= (int)sizeof(line)) return;
	if (tud_cdc_write_available() < (uint32_t)len) return;
	tud_cdc_write_str(line);
	tud_cdc_write_flush();
}
