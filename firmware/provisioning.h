#ifndef PROVISIONING_H
#define PROVISIONING_H

#include <stdbool.h>

#include "wifi_config.h"

/* Start the tiny HTTP server on the Pico's provisioning access point. */
void provisioning_start(wifi_config_t *cfg);

/* Print the setup/status line on the USB CDC port and handle the delayed reboot
   after a successful save. Call from the main loop. */
void provisioning_poll(wifi_config_t *cfg, bool provision);

#endif
