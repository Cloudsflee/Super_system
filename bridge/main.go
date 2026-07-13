//go:build windows

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/UserExistsError/conpty"
	"github.com/gorilla/websocket"
)

const (
	bridgeVersion   = "1.5.0"
	protocolVersion = 1
)

type config struct {
	DeviceID  string `json:"device_id"`
	Endpoint  string `json:"endpoint"`
	Encrypted []byte `json:"encrypted_credential"`
}

type frame struct {
	Type            string         `json:"type"`
	ProtocolVersion int            `json:"protocol_version,omitempty"`
	BridgeVersion   string         `json:"bridge_version,omitempty"`
	SessionID       string         `json:"session_id,omitempty"`
	Data            string         `json:"data,omitempty"`
	Command         string         `json:"command,omitempty"`
	Args            []string       `json:"args,omitempty"`
	Cwd             string         `json:"cwd,omitempty"`
	Cols            int            `json:"cols,omitempty"`
	Rows            int            `json:"rows,omitempty"`
	Capabilities    map[string]any `json:"capabilities,omitempty"`
	ExitCode        uint32         `json:"exit_code,omitempty"`
	Error           string         `json:"error,omitempty"`
	TransferID      string         `json:"transfer_id,omitempty"`
	BundleRef       string         `json:"bundle_ref,omitempty"`
	BaseCommit      string         `json:"base_commit,omitempty"`
	HeadCommit      string         `json:"head_commit,omitempty"`
	SHA256          string         `json:"sha256,omitempty"`
	Chunk           string         `json:"chunk,omitempty"`
	Sequence        int            `json:"sequence,omitempty"`
	TotalBytes      int64          `json:"total_bytes,omitempty"`
}

func main() {
	if len(os.Args) < 2 {
		fatal("usage: aiws-bridge <pair|run|status|version>")
	}
	var err error
	switch os.Args[1] {
	case "pair":
		if len(os.Args) < 3 {
			fatal("pairing_code_required")
		}
		err = pair(os.Args[2])
	case "run":
		err = run()
	case "status":
		err = status()
	case "version", "--version":
		fmt.Printf("aiws-windows-bridge %s protocol %d\n", bridgeVersion, protocolVersion)
	default:
		err = fmt.Errorf("unknown_command")
	}
	if err != nil {
		fatal(publicError(err))
	}
}

func pair(code string) error {
	if len(strings.TrimSpace(code)) != 12 {
		return errors.New("pairing_code_invalid")
	}
	endpoint := endpointURL()
	body, _ := json.Marshal(map[string]any{"action": "exchange", "pairing_code": strings.TrimSpace(code), "device_name": hostname(), "protocol_version": protocolVersion, "bridge_version": bridgeVersion})
	request, _ := http.NewRequest(http.MethodPost, endpoint+"/api/assist/v3/host-bridge/pairing", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 20 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("pairing_request_failed: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusCreated {
		return fmt.Errorf("pairing_rejected_%d", response.StatusCode)
	}
	var result struct {
		Device struct {
			ID string `json:"id"`
		} `json:"device"`
		Credential string `json:"credential"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&result); err != nil {
		return err
	}
	if result.Device.ID == "" || result.Credential == "" {
		return errors.New("pairing_response_invalid")
	}
	encrypted, err := protectCurrentUser([]byte(result.Credential))
	if err != nil {
		return fmt.Errorf("dpapi_protect_failed: %w", err)
	}
	return writeConfig(config{DeviceID: result.Device.ID, Endpoint: endpoint, Encrypted: encrypted})
}

func run() error {
	cfg, credential, err := loadCredential()
	if err != nil {
		return err
	}
	parsed, err := url.Parse(cfg.Endpoint)
	if err != nil {
		return err
	}
	if parsed.Scheme != "http" || parsed.Hostname() != "127.0.0.1" {
		return errors.New("endpoint_must_be_loopback")
	}
	parsed.Scheme = "ws"
	parsed.Path = "/api/assist/v3/host-bridge/ws"
	parsed.RawQuery = url.Values{"device_id": []string{cfg.DeviceID}}.Encode()
	headers := http.Header{}
	headers.Set("Authorization", "Bearer "+string(credential))
	conn, _, err := websocket.DefaultDialer.Dial(parsed.String(), headers)
	zero(credential)
	if err != nil {
		return fmt.Errorf("bridge_connect_failed: %w", err)
	}
	defer conn.Close()
	capabilities := detectCapabilities()
	if err := conn.WriteJSON(frame{Type: "hello", ProtocolVersion: protocolVersion, BridgeVersion: bridgeVersion, Capabilities: capabilities}); err != nil {
		return err
	}
	bridge := &runtimeBridge{conn: conn, terminals: map[string]*terminal{}, workspaces: map[string]*workspace{}, transfers: map[string]*incomingTransfer{}}
	defer bridge.close()
	go bridge.heartbeat()
	for {
		var message frame
		if err := conn.ReadJSON(&message); err != nil {
			return err
		}
		if err := bridge.handle(message); err != nil {
			bridge.write(frame{Type: "error", SessionID: message.SessionID, Error: publicError(err)})
		}
	}
}

type runtimeBridge struct {
	conn       *websocket.Conn
	writeMu    sync.Mutex
	mu         sync.Mutex
	terminals  map[string]*terminal
	workspaces map[string]*workspace
	transfers  map[string]*incomingTransfer
}
type terminal struct {
	pty    *conpty.ConPty
	cancel context.CancelFunc
}

func (b *runtimeBridge) handle(message frame) error {
	switch message.Type {
	case "hello_ack", "heartbeat_ack":
		return nil
	case "workspace_begin":
		return b.beginWorkspace(message)
	case "workspace_chunk":
		return b.appendWorkspace(message)
	case "workspace_end":
		return b.finishWorkspace(message)
	case "workspace_return_ack":
		return b.ackWorkspace(message)
	case "terminal_start":
		return b.startTerminal(message)
	case "terminal_input":
		b.mu.Lock()
		item := b.terminals[message.SessionID]
		b.mu.Unlock()
		if item == nil {
			return errors.New("terminal_not_found")
		}
		_, err := item.pty.Write([]byte(message.Data))
		return err
	case "terminal_resize":
		b.mu.Lock()
		item := b.terminals[message.SessionID]
		b.mu.Unlock()
		if item == nil {
			return errors.New("terminal_not_found")
		}
		return item.pty.Resize(clamp(message.Cols, 20, 400, 120), clamp(message.Rows, 5, 200, 32))
	case "terminal_stop":
		return b.stopTerminal(message.SessionID)
	default:
		return fmt.Errorf("unsupported_frame_%s", safeToken(message.Type))
	}
}

func (b *runtimeBridge) startTerminal(message frame) error {
	if !validID(message.SessionID) {
		return errors.New("terminal_session_invalid")
	}
	if filepath.Base(message.Command) != "codex.exe" && message.Command != "codex" && message.Command != "" {
		return errors.New("terminal_command_not_allowed")
	}
	command, err := exec.LookPath("codex.exe")
	if err != nil {
		return errors.New("codex_exe_unavailable")
	}
	b.mu.Lock()
	workspace := b.workspaces[message.SessionID]
	b.mu.Unlock()
	if workspace == nil {
		return errors.New("terminal_workspace_missing")
	}
	message.Cwd = workspace.path
	if !filepath.IsAbs(message.Cwd) {
		return errors.New("terminal_cwd_invalid")
	}
	line := quoteWindows(command)
	for _, arg := range message.Args {
		if strings.ContainsAny(arg, "\x00\r\n") {
			return errors.New("terminal_argument_invalid")
		}
		line += " " + quoteWindows(arg)
	}
	pty, err := conpty.Start(line, conpty.ConPtyDimensions(clamp(message.Cols, 20, 400, 120), clamp(message.Rows, 5, 200, 32)), conpty.ConPtyWorkDir(message.Cwd), conpty.ConPtyEnv(os.Environ()))
	if err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(context.Background())
	b.mu.Lock()
	if _, exists := b.terminals[message.SessionID]; exists {
		b.mu.Unlock()
		cancel()
		pty.Close()
		return errors.New("terminal_already_running")
	}
	b.terminals[message.SessionID] = &terminal{pty: pty, cancel: cancel}
	b.mu.Unlock()
	b.write(frame{Type: "terminal_started", SessionID: message.SessionID})
	go b.streamTerminal(ctx, message.SessionID, pty)
	return nil
}

func (b *runtimeBridge) streamTerminal(ctx context.Context, sessionID string, pty *conpty.ConPty) {
	done := make(chan struct{})
	go func() {
		defer close(done)
		buffer := make([]byte, 32*1024)
		for {
			count, err := pty.Read(buffer)
			if count > 0 {
				b.write(frame{Type: "terminal_output", SessionID: sessionID, Data: string(buffer[:count])})
			}
			if err != nil {
				return
			}
		}
	}()
	exitCode, err := pty.Wait(ctx)
	<-done
	returnErr := b.returnWorkspace(sessionID)
	if returnErr != nil && err == nil {
		err = returnErr
	}
	if err != nil {
		b.write(frame{Type: "terminal_exit", SessionID: sessionID, ExitCode: exitCode, Error: publicError(err)})
	} else {
		b.write(frame{Type: "terminal_exit", SessionID: sessionID, ExitCode: exitCode})
	}
	b.mu.Lock()
	delete(b.terminals, sessionID)
	b.mu.Unlock()
	pty.Close()
}

func (b *runtimeBridge) stopTerminal(id string) error {
	b.mu.Lock()
	item := b.terminals[id]
	if item != nil {
		delete(b.terminals, id)
	}
	b.mu.Unlock()
	if item == nil {
		return nil
	}
	item.cancel()
	return item.pty.Close()
}
func (b *runtimeBridge) heartbeat() {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		if err := b.write(frame{Type: "heartbeat"}); err != nil {
			return
		}
	}
}
func (b *runtimeBridge) write(value frame) error {
	b.writeMu.Lock()
	defer b.writeMu.Unlock()
	return b.conn.WriteJSON(value)
}
func (b *runtimeBridge) close() {
	b.mu.Lock()
	defer b.mu.Unlock()
	for id, item := range b.terminals {
		item.cancel()
		item.pty.Close()
		delete(b.terminals, id)
	}
	for id, item := range b.transfers {
		item.file.Close()
		os.Remove(item.path)
		delete(b.transfers, id)
	}
}

func status() error {
	cfg, credential, err := loadCredential()
	if err != nil {
		return err
	}
	zero(credential)
	fmt.Printf("paired device %s endpoint %s\n", cfg.DeviceID, cfg.Endpoint)
	return nil
}
func detectCapabilities() map[string]any {
	path, err := exec.LookPath("codex.exe")
	version := ""
	if err == nil {
		output, runErr := exec.Command(path, "--version").CombinedOutput()
		if runErr == nil {
			version = strings.TrimSpace(string(output))
		}
	}
	return map[string]any{"os": "windows", "arch": os.Getenv("PROCESSOR_ARCHITECTURE"), "conpty": conpty.IsConPtyAvailable(), "codex_available": err == nil, "codex_version": version, "code_page": "utf-8"}
}
func loadCredential() (config, []byte, error) {
	cfg, err := readConfig()
	if err != nil {
		return cfg, nil, err
	}
	credential, err := unprotectCurrentUser(cfg.Encrypted)
	if err != nil {
		return cfg, nil, fmt.Errorf("dpapi_unprotect_failed: %w", err)
	}
	return cfg, credential, nil
}
func configPath() string {
	root := os.Getenv("LOCALAPPDATA")
	if root == "" {
		root = os.TempDir()
	}
	return filepath.Join(root, "AIWS", "bridge", "config.json")
}
func writeConfig(value config) error {
	file := configPath()
	if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		return err
	}
	bytes, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	return writePrivateAtomic(file, bytes)
}
func readConfig() (config, error) {
	var value config
	bytes, err := os.ReadFile(configPath())
	if err != nil {
		return value, errors.New("bridge_not_paired")
	}
	err = json.Unmarshal(bytes, &value)
	return value, err
}
func endpointURL() string {
	value := strings.TrimRight(os.Getenv("AIWS_ENDPOINT"), "/")
	if value == "" {
		value = "http://127.0.0.1:4317"
	}
	return value
}
func hostname() string {
	value, _ := os.Hostname()
	if value == "" {
		return "Windows device"
	}
	return value
}
func validID(value string) bool {
	if len(value) < 1 || len(value) > 200 {
		return false
	}
	for _, r := range value {
		if !(r == '-' || r == '_' || r == '.' || r >= '0' && r <= '9' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z') {
			return false
		}
	}
	return true
}
func safeToken(value string) string {
	var b strings.Builder
	for _, r := range value {
		if r == '-' || r == '_' || r >= '0' && r <= '9' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' {
			b.WriteRune(r)
		}
	}
	if b.Len() == 0 {
		return "invalid"
	}
	return b.String()
}
func publicError(err error) string {
	if err == nil {
		return ""
	}
	return safeToken(strings.Split(err.Error(), ":")[0])
}
func quoteWindows(value string) string { return strconv.Quote(value) }
func clamp(value, min, max, fallback int) int {
	if value == 0 {
		return fallback
	}
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}
func zero(value []byte) {
	for i := range value {
		value[i] = 0
	}
}
func fatal(message string) { fmt.Fprintln(os.Stderr, message); os.Exit(1) }
