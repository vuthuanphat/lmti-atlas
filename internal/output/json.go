package output

import (
	"encoding/json"
	"io"

	"github.com/vuthuanphat/lmti-atlas/pkg/contract"
)

func WriteJSON(w io.Writer, command string, status string, warnings []contract.BoundaryMessage, errors []contract.BoundaryMessage, data any) error {
	if warnings == nil {
		warnings = []contract.BoundaryMessage{}
	}
	if errors == nil {
		errors = []contract.BoundaryMessage{}
	}
	envelope := contract.CLIEnvelope{
		SchemaVersion: contract.CLISchemaVersion,
		Command:       command,
		Status:        status,
		Warnings:      warnings,
		Errors:        errors,
		Data:          data,
	}
	encoder := json.NewEncoder(w)
	encoder.SetIndent("", "  ")
	return encoder.Encode(envelope)
}
