#ifndef CONTROLLER_H
#define CONTROLLER_H

#include <stdint.h>

#include "packet.h"

/* Apply an already assembled 84-byte frame (Wi-Fi path). Returns false when the
   inner frame is malformed, so the caller can count a bad frame. */
bool controller_apply_frame(uint8_t const frame[PACKET_SIZE]);

/* Momentary test pulse requested by an authenticated Wi-Fi TEST packet. */
void controller_test_state(uint8_t index, pad_state_t const *state, uint32_t duration_ms);

#endif
