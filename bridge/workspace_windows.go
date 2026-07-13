//go:build windows

package main

import (
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"hash"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const maxBundleBytes int64 = 128 * 1024 * 1024
const bridgeChunkBytes = 512 * 1024

type workspace struct {
	path       string
	baseCommit string
	headCommit string
}
type incomingTransfer struct {
	file          *os.File
	path          string
	sessionID     string
	transferID    string
	bundleRef     string
	baseCommit    string
	headCommit    string
	expectedHash  string
	expectedBytes int64
	receivedBytes int64
	sequence      int
	hasher        hash.Hash
}

func (b *runtimeBridge) beginWorkspace(message frame) error {
	if !validID(message.SessionID) || !validID(message.TransferID) || !validCommit(message.BaseCommit) || !validCommit(message.HeadCommit) || !validBundleRef(message.BundleRef) {
		return fmt.Errorf("workspace_metadata_invalid")
	}
	if message.TotalBytes <= 0 || message.TotalBytes > maxBundleBytes || len(message.SHA256) != 64 {
		return fmt.Errorf("workspace_size_invalid")
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, exists := b.transfers[message.TransferID]; exists {
		return fmt.Errorf("workspace_transfer_exists")
	}
	root := filepath.Join(localRoot(), "transfers")
	if err := os.MkdirAll(root, 0700); err != nil {
		return err
	}
	filePath := filepath.Join(root, message.TransferID+".bundle")
	file, err := os.OpenFile(filePath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	b.transfers[message.TransferID] = &incomingTransfer{file: file, path: filePath, sessionID: message.SessionID, transferID: message.TransferID, bundleRef: message.BundleRef, baseCommit: message.BaseCommit, headCommit: message.HeadCommit, expectedHash: strings.ToLower(message.SHA256), expectedBytes: message.TotalBytes, hasher: sha256.New()}
	return nil
}

func (b *runtimeBridge) appendWorkspace(message frame) error {
	b.mu.Lock()
	item := b.transfers[message.TransferID]
	b.mu.Unlock()
	if item == nil || item.sessionID != message.SessionID || message.Sequence != item.sequence {
		return fmt.Errorf("workspace_sequence_invalid")
	}
	bytes, err := base64.StdEncoding.DecodeString(message.Chunk)
	if err != nil || len(bytes) == 0 || len(bytes) > bridgeChunkBytes || item.receivedBytes+int64(len(bytes)) > item.expectedBytes {
		return fmt.Errorf("workspace_chunk_invalid")
	}
	if _, err = item.file.Write(bytes); err != nil {
		return err
	}
	item.hasher.Write(bytes)
	item.receivedBytes += int64(len(bytes))
	item.sequence++
	return nil
}

func (b *runtimeBridge) finishWorkspace(message frame) error {
	b.mu.Lock()
	item := b.transfers[message.TransferID]
	delete(b.transfers, message.TransferID)
	b.mu.Unlock()
	if item == nil || item.sessionID != message.SessionID {
		return fmt.Errorf("workspace_transfer_missing")
	}
	defer os.Remove(item.path)
	if err := item.file.Sync(); err != nil {
		item.file.Close()
		return err
	}
	if err := item.file.Close(); err != nil {
		return err
	}
	if item.receivedBytes != item.expectedBytes || fmt.Sprintf("%x", item.hasher.Sum(nil)) != item.expectedHash {
		return fmt.Errorf("workspace_checksum_invalid")
	}
	workspacePath, err := importWorkspace(item)
	if err != nil {
		return err
	}
	b.mu.Lock()
	b.workspaces[item.sessionID] = &workspace{path: workspacePath, baseCommit: item.baseCommit, headCommit: item.headCommit}
	b.mu.Unlock()
	return b.write(frame{Type: "workspace_ready", SessionID: item.sessionID, TransferID: item.transferID, Cwd: workspacePath, BaseCommit: item.baseCommit, HeadCommit: item.headCommit})
}

func importWorkspace(item *incomingTransfer) (string, error) {
	root := filepath.Join(localRoot(), "worktrees")
	if err := os.MkdirAll(root, 0700); err != nil {
		return "", err
	}
	target := filepath.Join(root, item.sessionID)
	if !within(root, target) {
		return "", fmt.Errorf("workspace_path_invalid")
	}
	if err := os.RemoveAll(target); err != nil {
		return "", err
	}
	if err := os.MkdirAll(target, 0700); err != nil {
		return "", err
	}
	if _, err := git(target, "init"); err != nil {
		return "", err
	}
	if _, err := git(target, "bundle", "verify", item.path); err != nil {
		return "", fmt.Errorf("workspace_bundle_verify_failed: %w", err)
	}
	if _, err := git(target, "fetch", "--no-tags", item.path, item.bundleRef+":refs/remotes/aiws/import"); err != nil {
		return "", fmt.Errorf("workspace_bundle_fetch_failed: %w", err)
	}
	if _, err := git(target, "checkout", "-B", "aiws", "refs/remotes/aiws/import"); err != nil {
		return "", err
	}
	head, err := git(target, "rev-parse", "HEAD")
	if err != nil || strings.TrimSpace(head) != item.headCommit {
		return "", fmt.Errorf("workspace_head_mismatch")
	}
	return target, nil
}

func (b *runtimeBridge) returnWorkspace(sessionID string) error {
	b.mu.Lock()
	item := b.workspaces[sessionID]
	b.mu.Unlock()
	if item == nil {
		return fmt.Errorf("workspace_missing")
	}
	status, err := git(item.path, "status", "--porcelain=v1", "--untracked-files=all")
	if err != nil {
		return err
	}
	if strings.TrimSpace(status) != "" {
		if _, err = git(item.path, "add", "-A"); err != nil {
			return err
		}
		if _, err = git(item.path, "-c", "user.name=AIWS Windows Bridge", "-c", "user.email=aiws@local.invalid", "commit", "-m", "checkpoint(aiws): windows bridge "+sessionID); err != nil {
			return err
		}
	}
	head, err := git(item.path, "rev-parse", "HEAD")
	if err != nil {
		return err
	}
	head = strings.TrimSpace(head)
	if _, err = git(item.path, "merge-base", "--is-ancestor", item.headCommit, head); err != nil {
		return fmt.Errorf("workspace_base_changed")
	}
	transferID := "return_" + strconv.FormatInt(time.Now().UnixNano(), 36)
	bundlePath := filepath.Join(localRoot(), "transfers", transferID+".bundle")
	if _, err = git(item.path, "bundle", "create", bundlePath, "refs/heads/aiws"); err != nil {
		return err
	}
	defer os.Remove(bundlePath)
	stat, err := os.Stat(bundlePath)
	if err != nil || stat.Size() <= 0 || stat.Size() > maxBundleBytes {
		return fmt.Errorf("workspace_return_size_invalid")
	}
	digest, err := fileDigest(bundlePath)
	if err != nil {
		return err
	}
	if err = b.write(frame{Type: "workspace_return_begin", SessionID: sessionID, TransferID: transferID, BaseCommit: item.headCommit, HeadCommit: head, TotalBytes: stat.Size(), SHA256: digest}); err != nil {
		return err
	}
	file, err := os.Open(bundlePath)
	if err != nil {
		return err
	}
	defer file.Close()
	buffer := make([]byte, bridgeChunkBytes)
	for sequence := 0; ; sequence++ {
		count, readErr := file.Read(buffer)
		if count > 0 {
			if err = b.write(frame{Type: "workspace_return_chunk", SessionID: sessionID, TransferID: transferID, Sequence: sequence, Chunk: base64.StdEncoding.EncodeToString(buffer[:count])}); err != nil {
				return err
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return readErr
		}
	}
	return b.write(frame{Type: "workspace_return_end", SessionID: sessionID, TransferID: transferID})
}

func (b *runtimeBridge) ackWorkspace(message frame) error {
	b.mu.Lock()
	item := b.workspaces[message.SessionID]
	delete(b.workspaces, message.SessionID)
	b.mu.Unlock()
	if item == nil {
		return nil
	}
	go func() {
		for attempt := 0; attempt < 10; attempt++ {
			if os.RemoveAll(item.path) == nil {
				return
			}
			time.Sleep(200 * time.Millisecond)
		}
	}()
	return nil
}

func git(cwd string, args ...string) (string, error) {
	command := exec.Command("git", args...)
	command.Dir = cwd
	command.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	output, err := command.CombinedOutput()
	if err != nil {
		return string(output), fmt.Errorf("git_failed: %s", strings.TrimSpace(string(output)))
	}
	return string(output), nil
}
func fileDigest(file string) (string, error) {
	handle, err := os.Open(file)
	if err != nil {
		return "", err
	}
	defer handle.Close()
	digest := sha256.New()
	if _, err = io.Copy(digest, handle); err != nil {
		return "", err
	}
	return fmt.Sprintf("%x", digest.Sum(nil)), nil
}
func localRoot() string {
	root := os.Getenv("LOCALAPPDATA")
	if root == "" {
		root = os.TempDir()
	}
	return filepath.Join(root, "AIWS")
}
func within(root, target string) bool {
	relative, err := filepath.Rel(filepath.Clean(root), filepath.Clean(target))
	return err == nil && relative != "" && relative != "." && relative != ".." && !strings.HasPrefix(relative, ".."+string(os.PathSeparator)) && !filepath.IsAbs(relative)
}
func validCommit(value string) bool {
	if len(value) != 40 && len(value) != 64 {
		return false
	}
	for _, char := range value {
		if !strings.ContainsRune("0123456789abcdef", char) {
			return false
		}
	}
	return true
}
func validBundleRef(value string) bool {
	return strings.HasPrefix(value, "refs/aiws-transfer/") && !strings.Contains(value, "..") && !strings.ContainsAny(value, "\\:\x00\r\n")
}
