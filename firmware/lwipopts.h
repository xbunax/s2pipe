#ifndef _LWIPOPTS_H
#define _LWIPOPTS_H

/* Small NO_SYS build for the Pico 2 W provisioning AP and UDP control socket.
   Based on the pico-examples lwIP options, trimmed to what s2pipe uses. */

#define NO_SYS 1
#define LWIP_SOCKET 0
#define LWIP_NETCONN 0
#define MEM_LIBC_MALLOC 1
#define MEM_ALIGNMENT 4
#define MEM_SIZE 8192

#define MEMP_NUM_TCP_PCB 4
#define MEMP_NUM_TCP_PCB_LISTEN 2
#define MEMP_NUM_TCP_SEG 16
#define MEMP_NUM_UDP_PCB 6
#define MEMP_NUM_ARP_QUEUE 10
#define PBUF_POOL_SIZE 16

#define LWIP_ARP 1
#define LWIP_ETHERNET 1
#define LWIP_ICMP 1
#define LWIP_RAW 1
#define LWIP_DHCP 1
#define LWIP_IPV4 1
#define LWIP_IPV6 0
#define LWIP_TCP 1
#define LWIP_UDP 1
#define LWIP_DNS 1
#define LWIP_TCP_KEEPALIVE 0

#define TCP_MSS 1460
#define TCP_WND (4 * TCP_MSS)
#define TCP_SND_BUF (4 * TCP_MSS)
#define TCP_SND_QUEUELEN ((4 * (TCP_SND_BUF) + (TCP_MSS - 1)) / (TCP_MSS))

#define LWIP_NETIF_STATUS_CALLBACK 1
#define LWIP_NETIF_LINK_CALLBACK 1
#define LWIP_NETIF_HOSTNAME 1
#define LWIP_NETIF_TX_SINGLE_PBUF 1
#define LWIP_CHKSUM_ALGORITHM 3

#define DHCP_DOES_ARP_CHECK 0
#define LWIP_DHCP_DOES_ACD_CHECK 0

/* Announcements are sent to 255.255.255.255 and the subnet broadcast. */
#define IP_SOF_BROADCAST 1
#define IP_SOF_BROADCAST_RECV 1

#define MEM_STATS 0
#define SYS_STATS 0
#define MEMP_STATS 0
#define LINK_STATS 0
#define LWIP_STATS 0
#define LWIP_DEBUG 0

#endif
