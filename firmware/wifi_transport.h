#ifndef WIFI_TRANSPORT_H
#define WIFI_TRANSPORT_H

#include <stdbool.h>
#include <stdint.h>

#include "wifi_config.h"

/* Initialise the CYW43 driver and lwIP once, before Wi-Fi or BLE. */
bool wifi_transport_platform_init(void);

/* Enter either the provisioning AP (no saved network) or STA mode. */
void wifi_transport_start(wifi_config_t *cfg, bool provision);

/* Drive the CYW43/lwIP poll loop and the Wi-Fi reconnect state machine. */
void wifi_transport_poll(void);

bool wifi_transport_is_connected(void);
bool wifi_transport_is_provisioning(void);
int32_t wifi_transport_rssi(void);
char const *wifi_transport_ip(void);
uint32_t wifi_transport_dhcp_leases(void);

#endif
