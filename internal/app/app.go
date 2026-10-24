package app

import (
	"context"
	"fmt"
	"io"

	"github.com/vuthuanphat/lmti-atlas/internal/config"
	"github.com/vuthuanphat/lmti-atlas/internal/memory"
	"github.com/vuthuanphat/lmti-atlas/internal/output"
	"github.com/vuthuanphat/lmti-atlas/internal/publish"
	"github.com/vuthuanphat/lmti-atlas/internal/storage"
	"github.com/vuthuanphat/lmti-atlas/pkg/contract"
)

func Run(args []string, stdout io.Writer, stderr io.Writer) int {
	if len(args) == 0 || args[0] == "help" || args[0] == "--help" {
		fmt.Fprintln(stdout, "LMTI - local AI memory, safety, and skill-routing layer")
		fmt.Fprintln(stdout, "Usage: lmti <init|check|doctor|route|memory|migrate|publish check|publish preflight|adapter inspect|thoth|skill> [--json]")
		return 0
	}
	switch args[0] {
	case "init":
		return runInit(args[1:], stdout, stderr)
	case "check":
		return runDoctor(args[1:], stdout, stderr)
	case "route":
		return runSkillAlias(append([]string{"route"}, args[1:]...), stdout, stderr)
	case "doctor":
		return runDoctor(args[1:], stdout, stderr)
	case "memory":
		return runMemory(args[1:], stdout, stderr)
	case "migrate":
		return runMigrate(args[1:], stdout, stderr)
	case "adapter":
		return runAdapter(args[1:], stdout, stderr)
	case "thoth":
		return runThoth(args[1:], stdout, stderr)
	case "skill":
		return runSkillAlias(args[1:], stdout, stderr)
	case "publish":
		if len(args) > 1 && (args[1] == "preflight" || args[1] == "check") {
			return runPublishPreflight(args[2:], stdout, stderr)
		}
	}
	fmt.Fprintf(stderr, "unknown command: %s\n", args[0])
	return 4
}

func runInit(args []string, stdout io.Writer, _ io.Writer) int {
	cfg, createdConfig, err := config.Ensure(".")
	var errors []contract.BoundaryMessage
	if err != nil {
		errors = append(errors, contract.BoundaryMessage{Code: contract.ErrorConfigInvalid, Message: err.Error()})
	}
	store := storage.NewSQLiteStore(cfg.Storage.Path)
	storageErr := store.Ensure(ctx(), ".")
	if storageErr != nil {
		errors = append(errors, contract.BoundaryMessage{Code: contract.ErrorStorageUnavailable, Message: storageErr.Error()})
	}
	data := InitResult{
		ConfigPath:    config.DefaultPath,
		ConfigCreated: createdConfig,
		StoragePath:   cfg.Storage.Path,
		StorageReady:  storageErr == nil,
	}
	status := contract.StatusPass
	if len(errors) > 0 {
		status = contract.StatusBlocked
	}
	if hasFlag(args, "--json") {
		_ = output.WriteJSON(stdout, "lmti.init", status, nil, errors, data)
		return exitForStatus(status)
	}
	fmt.Fprintln(stdout, "LMTI init")
	fmt.Fprintf(stdout, "Config: %s\n", data.ConfigPath)
	fmt.Fprintf(stdout, "Storage: %s\n", data.StoragePath)
	if len(errors) > 0 {
		for _, msg := range errors {
			fmt.Fprintf(stdout, "Blocked: %s - %s\n", msg.Code, msg.Message)
		}
	}
	return exitForStatus(status)
}

func runPublishPreflight(args []string, stdout io.Writer, _ io.Writer) int {
	cfg, err := config.Load(".")
	if err != nil {
		errs := []contract.BoundaryMessage{{Code: contract.ErrorConfigInvalid, Message: err.Error()}}
		if hasFlag(args, "--json") {
			_ = output.WriteJSON(stdout, "lmti.publish.preflight", contract.StatusError, nil, errs, map[string]string{})
			return 1
		}
		printMessages(stdout, errs)
		return 1
	}
	report, warnings, errors := publish.Preflight(ctx(), ".", cfg)
	status := report.Result
	if hasFlag(args, "--json") {
		_ = output.WriteJSON(stdout, "lmti.publish.preflight", status, warnings, errors, report)
		return exitForStatus(status)
	}
	fmt.Fprintln(stdout, "LMTI Publish Preflight")
	fmt.Fprintln(stdout, "| Check | Status | Detail |")
	fmt.Fprintln(stdout, "|---|---|---|")
	for _, check := range report.Checks {
		fmt.Fprintf(stdout, "| %s | %s | %s |\n", check.ID, check.Status, check.Detail)
	}
	fmt.Fprintf(stdout, "\nResult: %s\n", report.Result)
	return exitForStatus(status)
}

func runMemory(args []string, stdout io.Writer, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprintln(stderr, "Usage: lmti memory <add|search|retrieve|stats>")
		return 1
	}
	switch args[0] {
	case "add":
		return runMemoryAdd(args[1:], stdout, stderr)
	case "search":
		return runMemorySearch(args[1:], stdout, stderr, false)
	case "retrieve":
		return runMemorySearch(args[1:], stdout, stderr, true)
	case "stats":
		return runMemoryStats(args[1:], stdout, stderr)
	default:
		fmt.Fprintf(stderr, "unknown memory command: %s\n", args[0])
		return 1
	}
}

func runMemoryAdd(args []string, stdout io.Writer, stderr io.Writer) int {
	jsonOutput := hasFlag(args, "--json")
	cfg, err := config.Load(".")
	if err != nil {
		return writeCommandError(stdout, stderr, jsonOutput, "lmti.memory.add", contract.ErrorConfigInvalid, err.Error())
	}
	privacy, err := memory.ParsePrivacy(stringFlag(args, "--privacy", cfg.Privacy.Default))
	if err != nil {
		return writeCommandError(stdout, stderr, jsonOutput, "lmti.memory.add", contract.ErrorConfigInvalid, err.Error())
	}
	result, warnings, errors := memory.Add(ctx(), ".", cfg, memory.AddRequest{
		Kind:        stringFlag(args, "--kind", "note"),
		Title:       stringFlag(args, "--title", ""),
		Content:     stringFlag(args, "--content", ""),
		Privacy:     privacy,
		SourceAgent: stringFlag(args, "--source-agent", "lmti-cli"),
		Tags:        splitCSV(stringFlag(args, "--tags", "")),
		Metadata:    map[string]string{},
	})
	status := statusFromMessages(warnings, errors)
	if jsonOutput {
		_ = output.WriteJSON(stdout, "lmti.memory.add", status, warnings, errors, result)
		return exitForStatus(status)
	}
	if len(errors) > 0 {
		printMessages(stderr, errors)
		return exitForStatus(status)
	}
	fmt.Fprintf(stdout, "Memory added: %s\n", result.Record.ID)
	return exitForStatus(status)
}

func runMemorySearch(args []string, stdout io.Writer, stderr io.Writer, retrieve bool) int {
	jsonOutput := hasFlag(args, "--json")
	cfg, err := config.Load(".")
	command := "lmti.memory.search"
	if retrieve {
		command = "lmti.memory.retrieve"
	}
	if err != nil {
		return writeCommandError(stdout, stderr, jsonOutput, command, contract.ErrorConfigInvalid, err.Error())
	}
	query := positionalText(args)
	if retrieve {
		query = stringFlag(args, "--intent", query)
	}
	privacy, err := memory.ParsePrivacy(stringFlag(args, "--privacy-max", "internal"))
	if err != nil {
		return writeCommandError(stdout, stderr, jsonOutput, command, contract.ErrorConfigInvalid, err.Error())
	}
	result, warnings, errors := memory.Search(ctx(), ".", cfg, query, privacy, intFlag(args, "--limit", 8))
	status := statusFromMessages(warnings, errors)
	if jsonOutput {
		_ = output.WriteJSON(stdout, command, status, warnings, errors, result)
		return exitForStatus(status)
	}
	if len(errors) > 0 {
		printMessages(stderr, errors)
		return exitForStatus(status)
	}
	fmt.Fprintf(stdout, "Memory results for %q\n", result.Query)
	for _, record := range result.Records {
		fmt.Fprintf(stdout, "- %s [%s] %s\n", record.ID, record.Privacy, record.Title)
	}
	return exitForStatus(status)
}

func runMemoryStats(args []string, stdout io.Writer, stderr io.Writer) int {
	jsonOutput := hasFlag(args, "--json")
	cfg, err := config.Load(".")
	if err != nil {
		return writeCommandError(stdout, stderr, jsonOutput, "lmti.memory.stats", contract.ErrorConfigInvalid, err.Error())
	}
	result, warnings, errors := memory.Stats(ctx(), ".", cfg)
	status := statusFromMessages(warnings, errors)
	if jsonOutput {
		_ = output.WriteJSON(stdout, "lmti.memory.stats", status, warnings, errors, result)
		return exitForStatus(status)
	}
	if len(errors) > 0 {
		printMessages(stderr, errors)
		return exitForStatus(status)
	}
	fmt.Fprintln(stdout, "Memory stats")
	fmt.Fprintf(stdout, "Records: %d\n", result.TotalMemoryRecords)
	return exitForStatus(status)
}

func ctx() context.Context {
	return context.Background()
}

func hasFlag(args []string, flag string) bool {
	for _, arg := range args {
		if arg == flag {
			return true
		}
	}
	return false
}
