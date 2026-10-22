package policy

import (
	"context"
	"strings"

	"github.com/vuthuanphat/lmti-atlas/internal/secrets"
	"github.com/vuthuanphat/lmti-atlas/pkg/contract"
)

type DefaultGate struct{}

func (DefaultGate) Evaluate(_ context.Context, action contract.ActionRequest) (contract.PolicyResult, error) {
	result := contract.PolicyResult{Decision: contract.DecisionAllow}
	for _, path := range action.Paths {
		if secrets.IsProtectedPath(path) {
			result.Decision = contract.DecisionBlock
			result.Errors = append(result.Errors, contract.BoundaryMessage{
				Code:    contract.ErrorProtectedFileDetected,
				Message: "Protected file path is not allowed through the safety gate.",
			})
		}
	}
	switch strings.ToLower(action.Action) {
	case "publish", "push", "pull_request", "deploy", "export_memory", "database_migration", "destructive_cleanup":
		if result.Decision == contract.DecisionAllow {
			result.Decision = contract.DecisionRequireUserApproval
			result.Warnings = append(result.Warnings, contract.BoundaryMessage{
				Code:    contract.ErrorUnknown,
				Message: "High-risk action requires explicit safety gate approval.",
			})
		}
	}
	if action.Action == "" {
		result.Decision = contract.DecisionWarn
		result.Warnings = append(result.Warnings, contract.BoundaryMessage{
			Code:    contract.ErrorUnknown,
			Message: "Action type is missing.",
		})
	}
	return result, nil
}
