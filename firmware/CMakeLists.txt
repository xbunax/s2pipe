cmake_minimum_required(VERSION 3.17)

set(PICO_BOARD pico CACHE STRING "Pico board (pico, pico_w, pico2, pico2_w)")

include(${CMAKE_CURRENT_LIST_DIR}/pico_sdk_import.cmake)

project(s2pipe_pico C CXX ASM)
set(CMAKE_C_STANDARD 11)

# Only HMAC-SHA256 is needed; the project config avoids the bare-metal entropy
# problem in mbedtls's default configuration.
set(PICO_MBEDTLS_CONFIG_FILE "s2pipe_mbedtls_config.h")

pico_sdk_init()

add_executable(s2pipe_pico
	main.c
	packet.c
	usb_descriptors.c
	wake_ble.c
	wifi_config.c
)

target_include_directories(s2pipe_pico PRIVATE ${CMAKE_CURRENT_LIST_DIR})

target_link_libraries(s2pipe_pico
	pico_stdlib
	tinyusb_device
	tinyusb_board
	hardware_uart
	hardware_irq
	hardware_flash
	pico_flash
	pico_rand
	pico_unique_id
)

# Wi-Fi + BLE on the CYW43439. The same image keeps UART input working; the
# transport is selected on the PC side.
if (PICO_CYW43_SUPPORTED)
	target_sources(s2pipe_pico PRIVATE
		wifi_transport.c
		provisioning.c
		dhcpserver.c
	)
	target_link_libraries(s2pipe_pico
		pico_btstack_ble
		pico_btstack_cyw43
		pico_cyw43_arch_lwip_poll
		pico_mbedtls
	)
	target_compile_definitions(s2pipe_pico PRIVATE
		CYW43_ENABLE_BLUETOOTH=1
		S2PIPE_CYW43=1
	)
endif()

pico_enable_stdio_usb(s2pipe_pico 0)
pico_enable_stdio_uart(s2pipe_pico 0)
pico_add_extra_outputs(s2pipe_pico)

if (PICO_BOARD STREQUAL "pico2_w")
	add_custom_command(
		OUTPUT ${CMAKE_BINARY_DIR}/s2pipe-pico2w-wifi.uf2
		COMMAND ${CMAKE_COMMAND} -E copy_if_different
			${CMAKE_BINARY_DIR}/s2pipe_pico.uf2
			${CMAKE_BINARY_DIR}/s2pipe-pico2w-wifi.uf2
		DEPENDS s2pipe_pico ${CMAKE_BINARY_DIR}/s2pipe_pico.uf2
		VERBATIM
	)
	add_custom_target(s2pipe_wifi_uf2 ALL DEPENDS ${CMAKE_BINARY_DIR}/s2pipe-pico2w-wifi.uf2)
endif()

pico_set_program_name(s2pipe_pico "s2pipe")
pico_set_program_description(s2pipe_pico "s2pipe 8x HORI Pokken, UART or Wi-Fi")
