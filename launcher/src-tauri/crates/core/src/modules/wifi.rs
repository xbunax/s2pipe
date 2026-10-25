use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, ToSocketAddrs, UdpSocket};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const WIFI_MAGIC: u32 = 0x31573253;
const WIFI_VERSION: u8 = 1;
const WIFI_CONTROL_PORT: u16 = 30100;
const WIFI_DISCOVERY_PORT: u16 = 30101;
const PREFIX_LEN: usize = 24;
const HMAC_OFF: usize = 24;
const HMAC_LEN: usize = 16;
const PAYLOAD_OFF: usize = 40;
const PAYLOAD_MAX: usize = 200;

const TYPE_HELLO: u8 = 1;
const TYPE_HELLO_ACK: u8 = 2;
const TYPE_TEST: u8 = 6;
const TYPE_PING: u8 = 4;
const TYPE_PONG: u8 = 5;

const DISCOVERY_PROBE: &[u8] = br#"{"s2pipe":1,"type":"discover"}"#;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WifiDevice {
    pub id: String,
    pub name: String,
    pub ip: String,
    pub port: u16,
    pub disc: u16,
    pub fw: String,
    pub rssi: i32,
    pub session: u32,
    pub boot: u32,
    pub latency_ms: Option<u32>,
    pub last_seen_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WifiTestResult {
    pub id: String,
    pub name: String,
    pub ip: String,
    pub port: u16,
    pub latency_ms: u32,
    pub rssi: i32,
    pub firmware: String,
    pub pulsed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PicoSetup {
    pub port: String,
    pub id: String,
    pub ssid: String,
    pub password: String,
    pub psk: String,
    pub fw: String,
    pub mode: String,
}

#[derive(Debug, Deserialize)]
struct Announcement {
    s2pipe: u8,
    #[serde(rename = "type")]
    kind: String,
    id: String,
    name: Option<String>,
    ip: String,
    port: Option<u16>,
    disc: Option<u16>,
    fw: Option<String>,
    rssi: Option<i32>,
    session: Option<u32>,
    boot: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct SetupLine {
    id: String,
    ssid: String,
    #[serde(rename = "pass")]
    password: String,
    psk: String,
    fw: String,
    mode: String,
}

#[derive(Debug, Deserialize)]
struct HelloAck {
    nonce: u32,
    id: Option<String>,
    name: Option<String>,
    ip: Option<String>,
    port: Option<u16>,
    fw: Option<String>,
    rssi: Option<i32>,
    session: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct Pong {
    nonce: u32,
    rssi: Option<i32>,
}

#[derive(Debug)]
struct Packet {
    kind: u8,
    session: u32,
    payload: Vec<u8>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn now_ms_u32() -> u32 {
    now_ms() as u32
}

fn next_nonce() -> u32 {
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
    (now_ms_u32() ^ counter.wrapping_mul(0x9e3779b9)) | 1
}

fn decode_key(value: &str) -> Result<[u8; 32], String> {
    let compact: String = value
        .trim()
        .chars()
        .filter(|c| !c.is_whitespace() && *c != ':' && *c != '-')
        .collect();
    if compact.len() != 64 || !compact.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("pairing key must be 64 hex characters (32 bytes)".into());
    }
    let bytes = hex::decode(&compact).map_err(|error| error.to_string())?;
    let mut key = [0u8; 32];
    key.copy_from_slice(&bytes);
    Ok(key)
}

fn build_packet(
    key: &[u8; 32],
    kind: u8,
    session: u32,
    seq: u32,
    payload: &[u8],
) -> Result<Vec<u8>, String> {
    build_packet_at(key, kind, session, seq, now_ms_u32(), payload)
}

fn build_packet_at(
    key: &[u8; 32],
    kind: u8,
    session: u32,
    seq: u32,
    timestamp: u32,
    payload: &[u8],
) -> Result<Vec<u8>, String> {
    if payload.len() > PAYLOAD_MAX {
        return Err("Wi-Fi payload too large".into());
    }
    let mut packet = vec![0u8; PAYLOAD_OFF + payload.len()];
    packet[0..4].copy_from_slice(&WIFI_MAGIC.to_le_bytes());
    packet[4] = WIFI_VERSION;
    packet[5] = kind;
    packet[8..12].copy_from_slice(&session.to_le_bytes());
    packet[12..16].copy_from_slice(&seq.to_le_bytes());
    packet[16..20].copy_from_slice(&timestamp.to_le_bytes());
    packet[20..22].copy_from_slice(&(payload.len() as u16).to_le_bytes());
    packet[PAYLOAD_OFF..].copy_from_slice(payload);

    let mut mac = HmacSha256::new_from_slice(key).map_err(|error| error.to_string())?;
    mac.update(&packet[..PREFIX_LEN]);
    mac.update(payload);
    let result = mac.finalize().into_bytes();
    packet[HMAC_OFF..HMAC_OFF + HMAC_LEN].copy_from_slice(&result[..HMAC_LEN]);
    Ok(packet)
}

fn parse_packet(key: &[u8; 32], data: &[u8]) -> Option<Packet> {
    if data.len() < PAYLOAD_OFF || data.len() > PAYLOAD_OFF + PAYLOAD_MAX {
        return None;
    }
    if u32::from_le_bytes(data[0..4].try_into().ok()?) != WIFI_MAGIC || data[4] != WIFI_VERSION {
        return None;
    }
    let payload_len = u16::from_le_bytes(data[20..22].try_into().ok()?) as usize;
    if PAYLOAD_OFF + payload_len != data.len() {
        return None;
    }
    let payload = &data[PAYLOAD_OFF..];
    let mut mac = HmacSha256::new_from_slice(key).ok()?;
    mac.update(&data[..PREFIX_LEN]);
    mac.update(payload);
    let result = mac.finalize().into_bytes();
    if !constant_time_eq(&result[..HMAC_LEN], &data[HMAC_OFF..HMAC_OFF + HMAC_LEN]) {
        return None;
    }
    Some(Packet {
        kind: data[5],
        session: u32::from_le_bytes(data[8..12].try_into().ok()?),
        payload: payload.to_vec(),
    })
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (left, right) in a.iter().zip(b.iter()) {
        diff |= left ^ right;
    }
    diff == 0
}

fn parse_announcement(data: &[u8]) -> Option<Announcement> {
    let announcement: Announcement = serde_json::from_slice(data).ok()?;
    if announcement.s2pipe != 1 || announcement.kind != "announce" || announcement.id.is_empty() {
        return None;
    }
    Some(announcement)
}

fn local_ipv4() -> Option<Ipv4Addr> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    match socket.local_addr().ok()?.ip() {
        IpAddr::V4(ip) if !ip.is_loopback() && !ip.is_link_local() && !ip.is_unspecified() => Some(ip),
        _ => None,
    }
}

fn broadcast_addresses() -> Vec<Ipv4Addr> {
    let mut addresses = vec![Ipv4Addr::BROADCAST];
    if let Some(ip) = local_ipv4() {
        let octets = ip.octets();
        addresses.push(Ipv4Addr::new(octets[0], octets[1], octets[2], 255));
    }
    addresses
}

/// Listen for Pico announcements and probe the broadcast address. The Pico
/// announces every two seconds in STA mode, so a three-second scan does not
/// depend on the probe reaching it.
pub fn discover_wifi_devices(timeout_ms: u64) -> Result<Vec<WifiDevice>, String> {
    let timeout = Duration::from_millis(timeout_ms.clamp(800, 10_000));
    let deadline = Instant::now() + timeout;
    let socket = UdpSocket::bind(("0.0.0.0", WIFI_DISCOVERY_PORT)).map_err(|error| {
        format!(
            "cannot listen on UDP {WIFI_DISCOVERY_PORT}: {error}. Close other s2pipe windows and retry, or enter the Pico IP manually"
        )
    })?;
    socket.set_broadcast(true).map_err(|error| error.to_string())?;
    socket
        .set_read_timeout(Some(Duration::from_millis(200)))
        .map_err(|error| error.to_string())?;

    let mut devices: std::collections::BTreeMap<String, WifiDevice> = std::collections::BTreeMap::new();
    let mut buffer = [0u8; 512];
    let mut last_probe = Instant::now() - Duration::from_secs(5);

    while Instant::now() < deadline {
        if last_probe.elapsed() >= Duration::from_millis(500) {
            for address in broadcast_addresses() {
                let _ = socket.send_to(DISCOVERY_PROBE, (address, WIFI_DISCOVERY_PORT));
            }
            last_probe = Instant::now();
        }

        match socket.recv_from(&mut buffer) {
            Ok((len, from)) => {
                let Some(announcement) = parse_announcement(&buffer[..len]) else {
                    continue;
                };
                devices.insert(
                    announcement.id.clone(),
                    WifiDevice {
                        id: announcement.id,
                        name: announcement.name.unwrap_or_else(|| "Pico 2 W".into()),
                        ip: if announcement.ip.is_empty() {
                            from.ip().to_string()
                        } else {
                            announcement.ip
                        },
                        port: announcement.port.unwrap_or(WIFI_CONTROL_PORT),
                        disc: announcement.disc.unwrap_or(WIFI_DISCOVERY_PORT),
                        fw: announcement.fw.unwrap_or_default(),
                        rssi: announcement.rssi.unwrap_or(0),
                        session: announcement.session.unwrap_or(0),
                        boot: announcement.boot.unwrap_or(0),
                        latency_ms: None,
                        last_seen_ms: now_ms(),
                    },
                );
            }
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || error.kind() == std::io::ErrorKind::TimedOut =>
            {
                continue;
            }
            Err(error) => return Err(error.to_string()),
        }
    }

    Ok(devices.into_values().collect())
}

fn pico_ports() -> Result<Vec<String>, String> {
    let ports = serialport::available_ports().map_err(|error| error.to_string())?;
    Ok(ports
        .into_iter()
        .filter_map(|port| match &port.port_type {
            serialport::SerialPortType::UsbPort(info) if info.vid == 0x2E8A || info.vid == 0x0F0D => {
                Some(port.port_name)
            }
            _ => None,
        })
        .collect())
}

fn url_encode(bytes: &[u8]) -> String {
    let mut out = String::new();
    for &byte in bytes {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// Send the 2.4 GHz SSID/password to the Pico over its USB CDC port. The
/// password is never logged or stored by the launcher; the Pico writes it to
/// its flash config and reboots into STA mode.
pub fn provision_pico_wifi(ssid: &str, password: &str) -> Result<String, String> {
    let ssid = ssid.trim();
    if ssid.is_empty() || ssid.len() > 32 {
        return Err("Wi-Fi name must be 1-32 bytes".into());
    }
    if !password.is_empty() && !(8..=63).contains(&password.len()) {
        return Err("Wi-Fi password must be 8-63 characters, or empty for an open network".into());
    }

    let ports = pico_ports()?;
    if ports.is_empty() {
        return Err(
            "no Pico USB serial port found. Connect the Pico to this PC with a data USB cable"
                .into(),
        );
    }

    let command = format!(
        "S2PIPE-PROV ssid={}&pass={}\r\n",
        url_encode(ssid.as_bytes()),
        url_encode(password.as_bytes())
    );

    for name in ports {
        let mut port = match serialport::new(&name, 115_200)
            .timeout(Duration::from_millis(250))
            .open()
        {
            Ok(port) => port,
            Err(_) => continue,
        };
        let _ = port.write_data_terminal_ready(true);
        if port.write_all(command.as_bytes()).is_err() {
            continue;
        }
        let _ = port.flush();

        let deadline = Instant::now() + Duration::from_millis(3500);
        let mut line = Vec::new();
        let mut byte = [0u8; 1];
        while Instant::now() < deadline {
            match port.read(&mut byte) {
                Ok(1) => {
                    if byte[0] == b'\n' {
                        let text = String::from_utf8_lossy(&line).trim().to_string();
                        line.clear();
                        if text.starts_with("S2PIPE-PROV-OK") {
                            return Ok(name);
                        }
                        if let Some(reason) = text.strip_prefix("S2PIPE-PROV-ERR ") {
                            return Err(format!("Pico rejected the Wi-Fi settings: {reason}"));
                        }
                    } else if byte[0] != b'\r' {
                        line.push(byte[0]);
                        if line.len() > 1024 {
                            line.clear();
                        }
                    }
                }
                Ok(_) => {}
                Err(_) => {}
            }
        }
    }

    Err("the Pico did not answer the USB provisioning command. Check that it is connected to this PC and running the Wi-Fi firmware"
        .into())
}

/// Read the `S2PIPE-SETUP` line the firmware prints on its USB CDC interface.
/// Only Pico USB serial ports are probed; Bluetooth COM ports are ignored.
pub fn read_pico_setup() -> Result<PicoSetup, String> {
    let ports = pico_ports()?;
    if ports.is_empty() {
        return Err(
            "no Pico USB serial port found. Connect the Pico to this PC in setup mode (hold BOOTSEL for 5 seconds to reset Wi-Fi)"
                .into(),
        );
    }

    let mut saw_status = false;
    for port_name in ports {
        let mut port = match serialport::new(&port_name, 115_200)
            .timeout(Duration::from_millis(250))
            .open()
        {
            Ok(port) => port,
            Err(_) => continue,
        };
        let _ = port.write_data_terminal_ready(true);

        let deadline = Instant::now() + Duration::from_millis(2500);
        let mut line = Vec::new();
        let mut byte = [0u8; 1];
        while Instant::now() < deadline {
            match port.read(&mut byte) {
                Ok(1) => {
                    if byte[0] == b'\n' {
                        let text = String::from_utf8_lossy(&line).trim().to_string();
                        line.clear();
                        if let Some(json) = text.strip_prefix("S2PIPE-SETUP ") {
                            if let Ok(setup) = serde_json::from_str::<SetupLine>(json) {
                                return Ok(PicoSetup {
                                    port: port_name.clone(),
                                    id: setup.id,
                                    ssid: setup.ssid,
                                    password: setup.password,
                                    psk: setup.psk,
                                    fw: setup.fw,
                                    mode: setup.mode,
                                });
                            }
                        } else if text.starts_with("S2PIPE-STATUS ") {
                            saw_status = true;
                        }
                    } else if byte[0] != b'\r' {
                        line.push(byte[0]);
                        if line.len() > 1024 {
                            line.clear();
                        }
                    }
                }
                Ok(_) => {}
                Err(error)
                    if error.kind() == std::io::ErrorKind::TimedOut
                        || error.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(_) => {
                    // A disconnected CDC port should not abort the scan of the
                    // remaining candidates; the read timeout bounds this loop.
                }
            }
        }
    }

    if saw_status {
        Err(
            "the Pico is already configured. Hold BOOTSEL for 5 seconds while it is powered to reset Wi-Fi and enter setup mode"
                .into(),
        )
    } else {
        Err("no S2PIPE-SETUP line found. Connect the Pico to this PC while it is in setup mode".into())
    }
}

fn test_payload(pad: u8, buttons: u16, duration_ms: u16) -> Vec<u8> {
    let mut payload = vec![0u8; 5];
    payload[0] = pad;
    payload[1..3].copy_from_slice(&buttons.to_le_bytes());
    payload[3..5].copy_from_slice(&duration_ms.to_le_bytes());
    payload
}

/// Authenticate with the Pico, measure a real UDP RTT and optionally pulse A
/// on pad 0 so the user can confirm the controller path.
pub fn test_wifi_device(
    host: &str,
    port: u16,
    key_hex: &str,
    pulse: bool,
) -> Result<WifiTestResult, String> {
    let key = decode_key(key_hex)?;
    let target: SocketAddr = format!("{host}:{port}")
        .to_socket_addrs()
        .map_err(|error| error.to_string())?
        .next()
        .ok_or_else(|| format!("cannot resolve {host}:{port}"))?;

    let socket = UdpSocket::bind("0.0.0.0:0").map_err(|error| error.to_string())?;
    socket
        .set_read_timeout(Some(Duration::from_millis(200)))
        .map_err(|error| error.to_string())?;

    let nonce = next_nonce();
    let hello = build_packet(&key, TYPE_HELLO, 0, 1, &nonce.to_le_bytes())?;
    let started = Instant::now();
    socket.send_to(&hello, target).map_err(|error| error.to_string())?;

    let mut buffer = [0u8; 512];
    let mut session = 0u32;
    let mut ack: Option<HelloAck> = None;
    let deadline = Instant::now() + Duration::from_millis(1600);
    while Instant::now() < deadline {
        match socket.recv_from(&mut buffer) {
            Ok((len, _from)) => {
                let Some(packet) = parse_packet(&key, &buffer[..len]) else {
                    continue;
                };
                if packet.kind != TYPE_HELLO_ACK {
                    continue;
                }
                let Ok(parsed) = serde_json::from_slice::<HelloAck>(&packet.payload) else {
                    continue;
                };
                if parsed.nonce != nonce {
                    continue;
                }
                if parsed.session.is_some_and(|value| value != packet.session) {
                    continue;
                }
                session = packet.session;
                ack = Some(parsed);
                break;
            }
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || error.kind() == std::io::ErrorKind::TimedOut =>
            {
                continue;
            }
            Err(error) => return Err(error.to_string()),
        }
    }

    let ack = ack.ok_or_else(|| {
        "the Pico did not answer with a valid HELLO_ACK (check the IP and pairing key)".to_string()
    })?;

    let mut latency_ms = started.elapsed().as_millis() as u32;
    let mut rssi = ack.rssi.unwrap_or(0);

    let ping_nonce = next_nonce();
    let ping = build_packet(&key, TYPE_PING, session, 2, &ping_nonce.to_le_bytes())?;
    let ping_started = Instant::now();
    socket.send_to(&ping, target).map_err(|error| error.to_string())?;
    let deadline = Instant::now() + Duration::from_millis(1600);
    while Instant::now() < deadline {
        match socket.recv_from(&mut buffer) {
            Ok((len, _from)) => {
                let Some(packet) = parse_packet(&key, &buffer[..len]) else {
                    continue;
                };
                if packet.kind != TYPE_PONG {
                    continue;
                }
                let Ok(parsed) = serde_json::from_slice::<Pong>(&packet.payload) else {
                    continue;
                };
                if parsed.nonce != ping_nonce {
                    continue;
                }
                latency_ms = ping_started.elapsed().as_millis() as u32;
                if let Some(value) = parsed.rssi {
                    rssi = value;
                }
                break;
            }
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || error.kind() == std::io::ErrorKind::TimedOut =>
            {
                continue;
            }
            Err(error) => return Err(error.to_string()),
        }
    }

    let pulsed = if pulse {
        let payload = test_payload(0, 1 << 2, 150);
        let packet = build_packet(&key, TYPE_TEST, session, 3, &payload)?;
        socket.send_to(&packet, target).map_err(|error| error.to_string())?;
        true
    } else {
        false
    };

    Ok(WifiTestResult {
        id: ack.id.unwrap_or_default(),
        name: ack.name.unwrap_or_else(|| "Pico 2 W".into()),
        ip: ack.ip.unwrap_or_else(|| target.ip().to_string()),
        port: ack.port.unwrap_or(port),
        latency_ms,
        rssi,
        firmware: ack.fw.unwrap_or_default(),
        pulsed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_key() -> [u8; 32] {
        let mut key = [0u8; 32];
        for (index, byte) in key.iter_mut().enumerate() {
            *byte = index as u8;
        }
        key
    }

    #[test]
    fn protocol_vector_matches_node_and_firmware() {
        let packet = build_packet_at(
            &test_key(),
            TYPE_HELLO,
            0x11223344,
            5,
            0x01020304,
            &[0xde, 0xad, 0xbe, 0xef],
        )
        .unwrap();
        assert_eq!(
            hex::encode(packet),
            "533257310101000044332211050000000403020104000000df66075996c0aa2c76eea4b634134d7fdeadbeef"
        );
    }

    #[test]
    fn packet_round_trip_and_tamper_rejection() {
        let key = test_key();
        let packet = build_packet(&key, TYPE_PING, 7, 9, &[1, 2, 3, 4]).unwrap();
        let parsed = parse_packet(&key, &packet).expect("valid packet");
        assert_eq!(parsed.kind, TYPE_PING);
        assert_eq!(parsed.session, 7);
        assert_eq!(parsed.payload, vec![1, 2, 3, 4]);

        let mut tampered = packet;
        tampered[PAYLOAD_OFF] ^= 1;
        assert!(parse_packet(&key, &tampered).is_none());

        let mut other_key = key;
        other_key[0] ^= 1;
        assert!(parse_packet(&other_key, &tampered).is_none());
    }

    #[test]
    fn pairing_key_parser_rejects_bad_input() {
        let key = decode_key(&"00".repeat(32)).unwrap();
        assert_eq!(key, [0u8; 32]);
        assert!(decode_key("00").is_err());
        assert!(decode_key(&"zz".repeat(32)).is_err());
    }

    #[test]
    fn test_payload_is_five_bytes() {
        assert_eq!(test_payload(0, 1 << 2, 150), vec![0, 4, 0, 150, 0]);
    }

    #[test]
    fn usb_provisioning_url_encoding() {
        assert_eq!(url_encode(b"Example_2.4G"), "Example_2.4G");
        assert_eq!(url_encode(b"a b&c"), "a%20b%26c");
        assert_eq!(url_encode("密码".as_bytes()), "%E5%AF%86%E7%A0%81");
    }
}

#[cfg(test)]
mod client_tests {
    use super::*;
    use std::net::UdpSocket;
    use std::thread;

    fn test_key() -> [u8; 32] {
        let mut key = [0u8; 32];
        for (index, byte) in key.iter_mut().enumerate() {
            *byte = index as u8;
        }
        key
    }

    #[test]
    fn client_authenticates_and_measures_against_fake_pico() {
        let key = test_key();
        let key_hex = hex::encode(key);
        let server = UdpSocket::bind("127.0.0.1:0").unwrap();
        server
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let port = server.local_addr().unwrap().port();

        let handle = thread::spawn(move || {
            let mut buffer = [0u8; 512];

            let (len, from) = server.recv_from(&mut buffer).expect("hello");
            let hello = parse_packet(&key, &buffer[..len]).expect("valid hello");
            assert_eq!(hello.kind, TYPE_HELLO);
            let nonce = u32::from_le_bytes(hello.payload[..4].try_into().unwrap());
            let session = 0x12345678u32;
            let json = format!(
                "{{\"nonce\":{nonce},\"id\":\"test\",\"name\":\"Fake Pico\",\"ip\":\"127.0.0.1\",\"port\":{port},\"fw\":\"test\",\"rssi\":-55,\"session\":{session}}}"
            );
            let ack = build_packet(&key, TYPE_HELLO_ACK, session, 1, json.as_bytes()).unwrap();
            server.send_to(&ack, from).unwrap();

            let (len, from) = server.recv_from(&mut buffer).expect("ping");
            let ping = parse_packet(&key, &buffer[..len]).expect("valid ping");
            assert_eq!(ping.kind, TYPE_PING);
            let nonce = u32::from_le_bytes(ping.payload[..4].try_into().unwrap());
            let json = format!("{{\"nonce\":{nonce},\"rssi\":-55}}");
            let pong = build_packet(&key, TYPE_PONG, session, 2, json.as_bytes()).unwrap();
            server.send_to(&pong, from).unwrap();
        });

        let result = test_wifi_device("127.0.0.1", port, &key_hex, false).unwrap();
        assert_eq!(result.id, "test");
        assert_eq!(result.name, "Fake Pico");
        assert_eq!(result.rssi, -55);
        assert!(result.latency_ms < 1000);
        assert!(!result.pulsed);
        handle.join().unwrap();
    }
}
