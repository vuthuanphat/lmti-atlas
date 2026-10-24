package app

import (
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/vuthuanphat/lmti-atlas/internal/config"
	"github.com/vuthuanphat/lmti-atlas/internal/gitcheck"
	"github.com/vuthuanphat/lmti-atlas/internal/output"
	"github.com/vuthuanphat/lmti-atlas/internal/thoth"
	"github.com/vuthuanphat/lmti-atlas/pkg/contract"
)

type DoctorCheck struct {
	ID     string `json:"id"`
	Status string `json:"status"`
	Detail string `json:"detail"`
	Code   string `json:"code,omitempty"`
}

type DoctorReport struct {
	Result string        `json:"result"`
	Checks []DoctorCheck `json:"checks"`
}

func runDoctor(args []string, stdout io.Writer, _ io.Writer) int {
	report := buildDoctorReport(".")
	if hasFlag(args, "--json") {
		_ = output.WriteJSON(stdout, "lmti.doctor", report.Result, nil, nil, report)
		return exitForStatus(report.Result)
	}
	fmt.Fprintln(stdout, "LMTI Doctor")
	fmt.Fprintln(stdout, "| Check | Status | Detail |")
	fmt.Fprintln(stdout, "|---|---|---|")
	for _, check := range report.Checks {
		fmt.Fprintf(stdout, "| %s | %s | %s |\n", check.ID, check.Status, check.Detail)
	}
	fmt.Fprintf(stdout, "\nResult: %s\n", report.Result)
	return exitForStatus(report.Result)
}

func buildDoctorReport(root string) DoctorReport {
	var checks []DoctorCheck
	cfg, cfgErr := config.Load(root)
	if cfgErr != nil {
		checks = append(checks, doctorCheck("config", contract.StatusError, cfgErr.Error(), contract.ErrorConfigInvalid))
	} else if _, err := os.Stat(config.DefaultPath); err != nil {
		checks = append(checks, doctorCheck("config", contract.StatusWarn, "config.toml is missing; run lmti init to create it.", contract.ErrorConfigInvalid))
	} else {
		checks = append(checks, doctorCheck("config", contract.StatusPass, "config.toml is readable", ""))
	}
	if cfg.Storage.Engine != "sqlite" || cfg.Storage.Path == "" {
		checks = append(checks, doctorCheck("storage", contract.StatusError, "storage.engine must be sqlite and storage.path must be set", contract.ErrorStorageUnavailable))
	} else if _, err := os.Stat(cfg.Storage.Path); err != nil {
		checks = append(checks, doctorCheck("storage", contract.StatusWarn, "SQLite file is not initialized; run lmti init.", contract.ErrorMigrationRequired))
	} else {
		checks = append(checks, doctorCheck("storage", contract.StatusPass, cfg.Storage.Path, ""))
	}
	if cfg.Privacy.Default == "" || !cfg.Privacy.BlockSecret || !cfg.Privacy.BlockDoNotPrompt {
		checks = append(checks, doctorCheck("privacy", contract.StatusError, "privacy defaults must block secret output and do_not_prompt context", contract.ErrorPrivacyBlocked))
	} else {
		checks = append(checks, doctorCheck("privacy", contract.StatusPass, "privacy gates configured", ""))
	}
	if cfg.Publish.PublicRepo == "" || cfg.Publish.TargetBranch == "" {
		checks = append(checks, doctorCheck("publish", contract.StatusError, "publish target is incomplete", contract.ErrorPublishTargetMissing))
	} else {
		checks = append(checks, doctorCheck("publish", contract.StatusPass, cfg.Publish.PublicRepo+" -> "+cfg.Publish.TargetBranch, ""))
	}
	if _, err := thoth.LoadRegistry(root); err != nil {
		checks = append(checks, doctorCheck("thoth", contract.StatusError, err.Error(), contract.ErrorThothRegistryMissing))
	} else {
		checks = append(checks, doctorCheck("thoth", contract.StatusPass, "skill registry loads", ""))
	}
	git := gitcheck.Client{Root: root}
	if status, err := git.StatusPorcelain(ctx()); err != nil {
		checks = append(checks, doctorCheck("git", contract.StatusWarn, "could not inspect git status", contract.ErrorUnknown))
	} else if strings.TrimSpace(status) != "" {
		checks = append(checks, doctorCheck("git", contract.StatusWarn, "working tree has uncommitted changes", contract.ErrorWorkingTreeDirty))
	} else {
		checks = append(checks, doctorCheck("git", contract.StatusPass, "working tree clean", ""))
	}
	if content, err := os.ReadFile("README.md"); err != nil || !strings.Contains(string(content), "independent local AI memory, safety, and skill-routing layer") {
		checks = append(checks, doctorCheck("identity", contract.StatusError, "README must identify LMTI as an independent local layer", contract.ErrorConfigInvalid))
	} else {
		checks = append(checks, doctorCheck("identity", contract.StatusPass, "independent layer wording present", ""))
	}
	return DoctorReport{Result: resultFromDoctorChecks(checks), Checks: checks}
}

func doctorCheck(id string, status string, detail string, code contract.ErrorCode) DoctorCheck {
	check := DoctorCheck{ID: id, Status: status, Detail: detail}
	if code != "" {
		check.Code = string(code)
	}
	return check
}

func resultFromDoctorChecks(checks []DoctorCheck) string {
	result := contract.StatusPass
	for _, check := range checks {
		if check.Status == contract.StatusError || check.Status == contract.StatusBlocked {
			return contract.StatusBlocked
		}
		if check.Status == contract.StatusWarn {
			result = contract.StatusWarn
		}
	}
	return result
}
