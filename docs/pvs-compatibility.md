# PVS compatibility and read-only checks

The collector uses the official varserver interface. It does not require a specific firmware number in code, and it does not install PyPVS. Compatibility depends on authentication, response shapes, available fields and usable measurement times.

## Evidence and scope

| Gateway | Evidence | Project status |
| --- | --- | --- |
| PVS6 `2025.10.20.61846`, no battery | Actual household collection and recovery checks | Hardware verified |
| Other PVS6 builds exposing the official API | Official field definitions and synthetic response tests | Candidate; check actual readings |
| PVS5 exposing the official API | The 26 measurement/authentication/health paths and the two gateway diagnostic paths appear in both official variable tables with matching types and read roles | Candidate; no project hardware verification |
| PVS2, legacy-only gateways, other vendors | No implemented compatibility path | Unsupported |
| Battery systems | No complete storage/calibration verification | Outside the supported installation path |

The [official README at the reviewed revision](https://github.com/SunStrong-Management/pypvs/blob/adb6a61f6f272f1171d487949ccdb43183db8479/README.md) lists PVS5 `2025.11`, build `5412`, and PVS6 `2025.06`, build `61839`, as minimums. Its [LocalAPI document](https://github.com/SunStrong-Management/pypvs/blob/adb6a61f6f272f1171d487949ccdb43183db8479/doc/LocalAPI.md) instead lists PVS6 `61840+` and says PVS5 is coming soon. These inconsistent descriptions are not verified lower bounds for our collector.

The [PVS5 variable table](https://github.com/SunStrong-Management/pypvs/blob/adb6a61f6f272f1171d487949ccdb43183db8479/doc/varserver-variables-public-pvs5.csv) and [PVS6 table](https://github.com/SunStrong-Management/pypvs/blob/adb6a61f6f272f1171d487949ccdb43183db8479/doc/varserver-variables-public-pvs6.csv) share our eight site/time paths, ten inverter/time/serial paths, four meter/time paths and four authentication/health paths. PVS5 marks battery power as NOT USED. A listed field or its CSV default does not prove that a device supplies a valid reading.

## Implemented flow

```text
LAN host -> serial-based login and session cookie
  -> focused model/software-revision diagnostics
  -> existing site, meter, inverter and health reads
  -> response normalization and allowlisted field parsing
  -> existing live uploads, history rollups and local queue
```

Startup diagnostics expose only recognized PVS5/PVS6 model names and numeric software revisions. Serial numbers, MAC addresses, Wi-Fi settings, cookies and arbitrary response text are excluded. Unknown model/revision values or a failed metadata query do not block otherwise usable collection.

Every data read allows one authentication refresh for HTTP 401/403 or a JSON `errorcode`. A repeated rejection fails the read. Request spacing, timeout, group cooldown and periodic retries remain in place.

The client accepts flat path/value objects and validated `{ "values": [{ "name": "/path", "value": ... }] }` envelopes. Invalid envelope entries and duplicate names fail safely. Device parsing accepts:

- Flat paths such as `/sys/devices/inverter/0/p3phsumKw`.
- Documented nested objects such as `/sys/devices/21/inverter/data`, including JSON object strings.

Only allowlisted fields are parsed. If both layouts supply the same device index/field, explicit flat fields take precedence regardless of order. Missing or malformed fields remain unknown. Nested DC power remains DC; it is not substituted for missing AC output. Layouts that use different device identities still require hardware verification of panel membership and mapping.

## Run the existing check

From a source checkout on the collector host:

```sh
PVS_HOST=YOUR_PVS_LAN_IP python3 -m collector.main --check
```

For container/systemd commands, use [manual installation](manual-installation.md) or [operations](operations.md). The installer already invokes this check; no new prompts or settings are required. Avoid running a second check concurrently with a production collector.

The check writes no queue records or cloud data. It prints local normalized readings and reports:

- Gateway model/software revision, or unavailable metadata.
- Site `available` only when solar, reported load and grid power are valid and source time is within 60 seconds old or five seconds ahead. Measured zero is valid. Missing powers, missing time or an out-of-window timestamp make the check fail; verify the host/device clocks if time is the issue.
- Device groups as `available`, `partial`, or `unverified`. These indicate parsed power/timestamp fields, not confirmed freshness or installed device count. An empty group is unverified, including at night; it does not permanently disable polling. Partial or empty groups are reported without blocking usable site data. Transport/authentication failures still fail the check.
- `hardware_verified=no`: one successful pass does not establish freshness progression, calibration, array completeness or long-term recovery.

Exit status is nonzero for authentication, group-read failures or unusable core site data. Metadata absence alone is not a failure. Check the detailed group output even when exit status is zero.

Before claiming a new gateway/firmware is verified, confirm daytime readings, advancing timestamps, full panel membership, meter/CT interpretation and recovery after a session expiry. Share only model/revision and sanitized check evidence; exclude serials, LAN addresses, settings and credentials.

Credit: these compatibility changes are informed by SunStrong Management and PyPVS contributors' official API documentation and variable tables. See [references](references.md) and the [SDK evaluation](adr/0001-pypvs-client-evaluation.md).
