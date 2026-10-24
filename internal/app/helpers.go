package app

import (
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/vuthuanphat/lmti-atlas/internal/output"
	"github.com/vuthuanphat/lmti-atlas/pkg/contract"
)

type InitResult struct {
	ConfigPath    string `json:"configPath"`
	ConfigCreated bool   `json:"configCreated"`
	StoragePath   string `json:"storagePath"`
	StorageReady  bool   `json:"storageReady"`
}

func stringFlag(args []string, name string, fallback string) string {
	for index, arg := range args {
		if arg == name && index+1 < len(args) {
			return args[index+1]
		}
		if strings.HasPrefix(arg, name+"=") {
			return strings.TrimPrefix(arg, name+"=")
		}
	}
	return fallback
}

func intFlag(args []string, name string, fallback int) int {
	value := stringFlag(args, name, "")
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}

func splitCSV(value string) []string {
	if strings.TrimSpace(value) == "" {
		return []string{}
	}
	parts := strings.Split(value, ",")
	items := make([]string, 0, len(parts))
	for _, part := range parts {
		item := strings.TrimSpace(part)
		if item != "" {
			items = append(items, item)
		}
	}
	return items
}

func statusFromMessages(warnings []contract.BoundaryMessage, errors []contract.BoundaryMessage) string {
	if len(errors) > 0 {
		for _, msg := range errors {
			if msg.Code == contract.ErrorPrivacyBlocked || msg.Code == contract.ErrorSecretDetected || msg.Code == contract.ErrorStorageUnavailable {
				return contract.StatusBlocked
			}
		}
		return contract.StatusError
	}
	if len(warnings) > 0 {
		return contract.StatusWarn
	}
	return contract.StatusPass
}

func exitForStatus(status string) int {
	switch status {
	case contract.StatusBlocked:
		return 2
	case contract.StatusError:
		return 3
	case contract.StatusWarn:
		return 1
	default:
		return 0
	}
}

func printMessages(w io.Writer, messages []contract.BoundaryMessage) {
	for _, msg := range messages {
		fmt.Fprintf(w, "%s: %s\n", msg.Code, msg.Message)
	}
}

func writeCommandError(stdout io.Writer, stderr io.Writer, jsonOutput bool, command string, code contract.ErrorCode, message string) int {
	errors := []contract.BoundaryMessage{{Code: code, Message: message}}
	if jsonOutput {
		_ = output.WriteJSON(stdout, command, contract.StatusError, nil, errors, map[string]string{})
		return exitForStatus(contract.StatusError)
	}
	printMessages(stderr, errors)
	return exitForStatus(contract.StatusError)
}
