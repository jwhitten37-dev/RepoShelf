# Phase 6: Corporate CA and Proxy Support Gate

## Status and scope

RepoShelf's locally testable corporate-network controls are implemented. Actual
compatibility remains gated on sanitized native-Windows and Remote–WSL validation
against the organization's approved CA, proxy, and Git credential configuration.

RepoShelf has two independent network paths:

1. GitLab API requests run in the VS Code extension host using Node.js `fetch`.
2. Clone, fetch, and push run through the host's native `git` executable.

Configuring one path does not prove or configure the other. Native Windows and
Remote–WSL also have separate extension hosts, environments, trust stores, Git
installations, and credential helpers.

## Security contract

- TLS certificate verification is mandatory. RepoShelf provides no setting to
  ignore certificate errors and refuses API use when
  `NODE_TLS_REJECT_UNAUTHORIZED=0` is inherited.
- RepoShelf refuses native Git use when `GIT_SSL_NO_VERIFY` is inherited with a
  truthy value. Do not use `http.sslVerify=false` in Git configuration.
- PATs and proxy credentials must not be placed in RepoShelf settings, Git remote
  URLs, command arguments, screenshots, logs, or committed evidence.
- RepoShelf does not implement a custom proxy credential store. Use only approved
  host, VS Code, operating-system, and native-Git mechanisms.
- API credentials remain constrained to the configured GitLab origin and exact
  API path. Proxy use does not relax redirect or retry controls.
- TLS failures and HTTP 407 proxy-authentication failures are deterministic and
  receive no automatic retry. Remote POST writes remain single-dispatch.

## GitLab API path: extension-host startup configuration

Node.js 24 supports environment-proxy routing for `fetch` when enabled at process
startup with `NODE_USE_ENV_PROXY=1`. The extension cannot safely enable this after
the VS Code extension host has started. Configure the environment that launches
the relevant extension host, then fully restart that host.

The approved host configuration may use:

- `NODE_USE_ENV_PROXY=1`
- `HTTPS_PROXY` for the HTTPS proxy URL
- `HTTP_PROXY` where required by the environment
- `NO_PROXY` for approved direct destinations

Proxy URLs can contain credentials, but embedding them in environment variables is
not recommended. Prefer an organization-approved integrated authentication or
credential mechanism. Never copy such values into RepoShelf diagnostics.

For a private CA not already trusted by the extension-host Node runtime, the
approved startup environment may use:

- `NODE_EXTRA_CA_CERTS=/absolute/path/to/approved-corporate-ca-bundle.pem`

`NODE_EXTRA_CA_CERTS` is read only when the Node process starts. The file must be
an approved PEM certificate bundle, readable by the extension-host account, and
protected from unauthorized modification. A full extension-host restart is
required after changing it. Do not use `NODE_TLS_REJECT_UNAUTHORIZED=0`.

VS Code's window/Chromium network stack normally uses system proxy and certificate
facilities, but VS Code documents that extensions do not yet benefit from all of
the same proxy support. A successful Marketplace or window request therefore does
not prove that RepoShelf's extension-host API request can reach GitLab.

## Native Git path

RepoShelf delegates HTTPS Git operations to the native Git executable and inherits
its host environment and Git configuration. Use organization-approved mechanisms,
which may include:

- OS or distribution CA installation;
- Git `http.sslCAInfo` pointing to an approved CA bundle;
- Git `http.proxy` or approved proxy environment variables;
- the configured HTTPS credential helper.

RepoShelf keeps `GIT_TERMINAL_PROMPT=0` and does not insert PATs or proxy
credentials into Git URLs or arguments. Interactive proxy or Git credential
prompts cannot be relied upon during managed operations. Do not disable
`http.sslVerify` and do not set `GIT_SSL_NO_VERIFY`.

## Environment-specific setup boundary

### Native Windows

- Configure the approved Windows trust/proxy path before launching VS Code.
- Ensure the Windows extension host receives any required Node startup variables.
- Configure and validate the Windows Git installation and credential helper.
- Fully exit all VS Code processes before retesting startup-only variables.

### Remote–WSL

- Configure the WSL distribution's CA bundle, environment, Git installation, and
  credential helper independently from Windows.
- Ensure startup variables reach the **remote WSL extension host**, not only the
  Windows VS Code client or an interactive shell.
- Restart the WSL extension host after changing startup-only variables. A Windows
  trust-store change alone does not establish Linux/WSL trust.

Exact installation and policy steps are organization- and distribution-specific.
RepoShelf documentation intentionally does not instruct users to install an
unverified certificate or bypass managed policy.

## Automated evidence

Automated tests must prove:

- common nested Node certificate errors map to the bounded `tls` category;
- HTTP 407 maps to `proxyAuthentication` and is not retried;
- TLS errors are not retried;
- proxy authorization headers, URL userinfo, and proxy password object fields are
  redacted;
- API use fails closed under `NODE_TLS_REJECT_UNAUTHORIZED=0`;
- native Git use fails closed under truthy `GIT_SSL_NO_VERIFY`;
- no RepoShelf setting or implementation enables an insecure TLS mode;
- POST remains single-dispatch under all retry settings.

## Manual corporate validation matrix

Use an authorized test account and disposable project. Record only pass/fail,
product/runtime versions, configuration-path category, and artifact provenance.
Do not record internal URLs, proxy names, usernames, certificate contents or
paths, environment values, PATs, cookies, or authorization headers.

| ID  | Environment | Path       | Test                                                        | Expected result                                                        | Result  |
| --- | ----------- | ---------- | ----------------------------------------------------------- | ---------------------------------------------------------------------- | ------- |
| N01 | Windows     | API        | Approved CA/proxy configuration and connection test         | Authenticated GitLab identity is returned                              | Not run |
| N02 | Windows     | API        | Corporate CA unavailable in a disposable test configuration | Bounded TLS guidance; no token, certificate, or proxy detail in output | Not run |
| N03 | Windows     | API        | Invalid/unavailable proxy in disposable configuration       | Bounded network/proxy guidance; no automatic write                     | Not run |
| N04 | Windows     | API        | Proxy authentication rejected                               | Bounded proxy-authentication guidance; credentials absent from logs    | Not run |
| N05 | Windows     | Native Git | Clone/fetch using approved CA, proxy, and credential helper | Operation succeeds without URL/argv credentials                        | Not run |
| N06 | Windows     | Native Git | Push to disposable branch                                   | Push and exact verification succeed                                    | Not run |
| N07 | Remote–WSL  | API        | Approved WSL extension-host CA/proxy configuration          | Authenticated GitLab identity is returned                              | Not run |
| N08 | Remote–WSL  | API        | Missing WSL CA or invalid proxy                             | Bounded safe failure; Windows trust is not assumed                     | Not run |
| N09 | Remote–WSL  | Native Git | Clone/fetch using WSL Git and credential helper             | Operation succeeds without URL/argv credentials                        | Not run |
| N10 | Remote–WSL  | Native Git | Push to disposable branch                                   | Push and exact verification succeed                                    | Not run |
| N11 | Both        | Logging    | Inspect RepoShelf output after all success/failure cases    | No credentials, environment dump, CA contents, or sensitive URLs       | Not run |
| N12 | Both        | TLS policy | Attempt documented insecure TLS environment                 | RepoShelf refuses the operation                                        | Not run |

## Authoritative references

- [Node.js 24 command-line and environment options](https://nodejs.org/docs/latest-v24.x/api/cli.html)
- [VS Code network connections](https://code.visualstudio.com/docs/setup/network)
- [Git configuration reference](https://git-scm.com/docs/git-config)
