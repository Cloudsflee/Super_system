//go:build windows

package main

import (
	"fmt"
	"os"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

type dataBlob struct {
	size uint32
	data *byte
}

var crypt32 = syscall.NewLazyDLL("crypt32.dll")
var kernel32 = syscall.NewLazyDLL("kernel32.dll")
var cryptProtectData = crypt32.NewProc("CryptProtectData")
var cryptUnprotectData = crypt32.NewProc("CryptUnprotectData")
var localFree = kernel32.NewProc("LocalFree")

const cryptProtectUIForbidden = 0x1 // No LOCAL_MACHINE flag: DPAPI is bound to Windows CurrentUser.

func protectCurrentUser(plain []byte) ([]byte, error) { return cryptData(cryptProtectData, plain) }
func unprotectCurrentUser(cipher []byte) ([]byte, error) {
	return cryptData(cryptUnprotectData, cipher)
}
func cryptData(proc *syscall.LazyProc, input []byte) ([]byte, error) {
	if len(input) == 0 {
		return nil, fmt.Errorf("empty_input")
	}
	in := dataBlob{size: uint32(len(input)), data: &input[0]}
	var out dataBlob
	result, _, callErr := proc.Call(uintptr(unsafe.Pointer(&in)), 0, 0, 0, 0, cryptProtectUIForbidden, uintptr(unsafe.Pointer(&out)))
	if result == 0 {
		return nil, callErr
	}
	defer localFree.Call(uintptr(unsafe.Pointer(out.data)))
	value := make([]byte, out.size)
	copy(value, unsafe.Slice(out.data, out.size))
	return value, nil
}

func writePrivateAtomic(file string, value []byte) error {
	temp := file + ".tmp"
	handle, err := os.OpenFile(temp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if os.IsExist(err) {
		os.Remove(temp)
		handle, err = os.OpenFile(temp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	}
	if err != nil {
		return err
	}
	if _, err = handle.Write(value); err == nil {
		err = handle.Sync()
	}
	if closeErr := handle.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		os.Remove(temp)
		return err
	}
	from, _ := windows.UTF16PtrFromString(temp)
	to, _ := windows.UTF16PtrFromString(file)
	if err = windows.MoveFileEx(from, to, windows.MOVEFILE_REPLACE_EXISTING|windows.MOVEFILE_WRITE_THROUGH); err != nil {
		os.Remove(temp)
	}
	return err
}
