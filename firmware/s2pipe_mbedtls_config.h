#ifndef S2PIPE_MBEDTLS_CONFIG_H
#define S2PIPE_MBEDTLS_CONFIG_H

/* Minimal bare-metal mbedtls configuration: only HMAC-SHA256 is used for the
   Wi-Fi control packet authentication. No TLS, filesystem or platform
   entropy is needed. */

#define MBEDTLS_NO_PLATFORM_ENTROPY
#define MBEDTLS_SHA256_C
#define MBEDTLS_SHA256_SMALLER
#define MBEDTLS_MD_C

#endif
