#include "hardware/gpio.h"
#include "hardware/irq.h"
#include "hardware/uart.h"
#include "hardware/watchdog.h"
#include "pico/stdlib.h"
#include "tusb.h"

#if __has_include("bsp/board_api.h")
#include "bsp/board_api.h"
#else
#include "bsp/board.h"
#endif

#include "controller.h"
#include "packet.h"
#include "wake_ble.h"
#include "wifi_config.h"

#if S2PIPE_CYW43
#include "provisioning.h"
#include "wifi_transport.h"
#endif

#include <string.h>

#if CFG_TUD_HID != PAD_COUNT
#error "CFG_TUD_HID must match PAD_COUNT"
#endif

#define UART_ID uart1
#define UART_IRQ UART1_IRQ
#define UART_TX_PIN 4
#define UART_RX_PIN 5
#define UART_BAUD 921600
#define STALE_MS 250
#define RESET_HOLD_MS 5000

#define BTN_UP (1u << 14)
#define BTN_DOWN (1u << 15)
#define BTN_LEFT (1u << 16)
#define BTN_RIGHT (1u << 17)

typedef struct TU_ATTR_PACKED {
	uint16_t buttons;
	uint8_t hat;
	uint8_t lx;
	uint8_t ly;
	uint8_t rx;
	uint8_t ry;
	uint8_t vendor;
} hid_report_t;

_Static_assert(sizeof(hid_report_t) == 8, "HORI input report is 8 bytes");

extern void usb_descriptors_set_serial(char const *serial);

static pad_state_t pads[PAD_COUNT];
static uint32_t last_packet_ms;
static bool test_active;
static uint32_t test_until_ms;

static uint8_t hat_from(uint32_t buttons) {
	int up = (buttons & BTN_UP) != 0;
	int down = (buttons & BTN_DOWN) != 0;
	int left = (buttons & BTN_LEFT) != 0;
	int right = (buttons & BTN_RIGHT) != 0;
	if (up && right) return 1;
	if (right && down) return 3;
	if (down && left) return 5;
	if (left && up) return 7;
	if (up) return 0;
	if (right) return 2;
	if (down) return 4;
	if (left) return 6;
	return 8;
}

static void fill_report(pad_state_t const *pad, hid_report_t *report) {
	report->buttons = (uint16_t)(pad->buttons & 0x3fff);
	report->hat = hat_from(pad->buttons);
	report->lx = pad->lx;
	report->ly = pad->ly;
	report->rx = pad->rx;
	report->ry = pad->ry;
	report->vendor = 0;
}

static uint8_t rx_buf[256];
static volatile uint8_t rx_head;
static volatile uint8_t rx_tail;

static void on_uart_rx(void) {
	while (uart_is_readable(UART_ID)) {
		uint8_t next = (uint8_t)(rx_head + 1);
		uint8_t byte = (uint8_t)uart_getc(UART_ID);
		if (next == rx_tail) continue;
		rx_buf[rx_head] = byte;
		rx_head = next;
	}
}

static uint32_t now_ms(void) {
	return to_ms_since_boot(get_absolute_time());
}

static void note_packet(void) {
	uint32_t now = now_ms();
	last_packet_ms = now ? now : 1;
}

static void handle_wake(void) {
	uint8_t sw[6];
	uint8_t pad[6];
	uint16_t pid;
	if (packet_take_wake(sw, pad, &pid)) wake_ble_request(sw, pad, pid);
}

bool controller_apply_frame(uint8_t const frame[PACKET_SIZE]) {
	if (!packet_apply_frame(frame, pads)) return false;
	note_packet();
	test_active = false;
	handle_wake();
	return true;
}

void controller_test_state(uint8_t index, pad_state_t const *state, uint32_t duration_ms) {
	if (index >= PAD_COUNT || !state) return;
	pads[index] = *state;
	note_packet();
	test_active = true;
	if (duration_ms > 250) duration_ms = 250;
	if (duration_ms == 0) duration_ms = 50;
	test_until_ms = now_ms() + duration_ms;
}

static void uart_drain(void) {
	while (rx_tail != rx_head) {
		uint8_t byte = rx_buf[rx_tail];
		rx_tail = (uint8_t)(rx_tail + 1);
		if (!packet_push(byte, pads)) continue;
		note_packet();
		test_active = false;
		handle_wake();
	}
}

static void controller_tick(void) {
	uint32_t now = now_ms();
	if (test_active) {
		if ((int32_t)(now - test_until_ms) >= 0) {
			packet_neutral(pads);
			test_active = false;
			last_packet_ms = 0;
		}
		return;
	}
	if (last_packet_ms && now - last_packet_ms >= STALE_MS) {
		packet_neutral(pads);
		last_packet_ms = 0;
	}
}

static void hid_push(void) {
	if (tud_suspended()) {
		tud_remote_wakeup();
		return;
	}
	if (!tud_mounted()) return;
	for (uint8_t i = 0; i < PAD_COUNT; i++) {
		if (!tud_hid_n_ready(i)) continue;
		hid_report_t report;
		fill_report(&pads[i], &report);
		tud_hid_n_report(i, 0, &report, sizeof(report));
	}
}

uint16_t tud_hid_get_report_cb(
	uint8_t instance,
	uint8_t report_id,
	hid_report_type_t report_type,
	uint8_t *buffer,
	uint16_t reqlen
) {
	(void)report_id;
	(void)report_type;
	if (instance >= PAD_COUNT || reqlen < sizeof(hid_report_t)) return 0;
	hid_report_t report;
	fill_report(&pads[instance], &report);
	memcpy(buffer, &report, sizeof(report));
	return sizeof(report);
}

void tud_hid_set_report_cb(
	uint8_t instance,
	uint8_t report_id,
	hid_report_type_t report_type,
	uint8_t const *buffer,
	uint16_t bufsize
) {
	(void)instance;
	(void)report_id;
	(void)report_type;
	(void)buffer;
	(void)bufsize;
}

#if S2PIPE_CYW43
static void reset_button_poll(wifi_config_t *cfg) {
	static uint32_t pressed_since;
	uint32_t now = now_ms();
	if (board_button_read()) {
		if (!pressed_since) pressed_since = now ? now : 1;
		if (now - pressed_since >= RESET_HOLD_MS) {
			wifi_config_clear_network(cfg);
			wifi_config_save(cfg);
			watchdog_reboot(0, 0, 100);
		}
	} else {
		pressed_since = 0;
	}
}
#endif

int main(void) {
	board_init();
	packet_init(pads);

	wifi_config_t cfg;
	wifi_config_load(&cfg);
	bool provision = !wifi_config_has_network(&cfg);

	char device_id[17];
	wifi_config_device_id_hex(&cfg, device_id);
	usb_descriptors_set_serial(device_id);

	uart_init(UART_ID, UART_BAUD);
	gpio_set_function(UART_TX_PIN, GPIO_FUNC_UART);
	gpio_set_function(UART_RX_PIN, GPIO_FUNC_UART);
	uart_set_hw_flow(UART_ID, false, false);
	uart_set_format(UART_ID, 8, 1, UART_PARITY_NONE);
	uart_set_fifo_enabled(UART_ID, true);
	irq_set_exclusive_handler(UART_IRQ, on_uart_rx);
	irq_set_enabled(UART_IRQ, true);
	uart_set_irq_enables(UART_ID, true, false);

	tud_init(BOARD_TUD_RHPORT);
#if __has_include("bsp/board_api.h")
	if (board_init_after_tusb) board_init_after_tusb();
#endif

	bool cyw43_ok = false;
#if S2PIPE_CYW43
	cyw43_ok = wifi_transport_platform_init();
	if (cyw43_ok) {
		wifi_transport_start(&cfg, provision);
		/* The provisioning AP does not need the BLE stack, and bringing BT up
		   while Wi-Fi is starting can make the CYW43439 drop the link. BLE is
		   started lazily after the STA link is up. */
	}
#else
	(void)provision;
	(void)cyw43_ok;
#endif

#if S2PIPE_CYW43
	bool ble_started = false;
#endif

	while (1) {
		tud_task();
		uart_drain();
#if S2PIPE_CYW43
		if (cyw43_ok) {
			wifi_transport_poll();
			if (!provision && !ble_started && wifi_transport_is_connected()) {
				wake_ble_init();
				ble_started = true;
			}
			if (ble_started) wake_ble_poll();
			provisioning_poll(&cfg, provision);
			reset_button_poll(&cfg);
		}
#endif
		controller_tick();
		hid_push();
	}
}
