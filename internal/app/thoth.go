package app

import (
	"fmt"
	"io"
	"strings"

	"github.com/vuthuanphat/lmti-atlas/internal/thoth"
)

func runThoth(args []string, stdout io.Writer, stderr io.Writer) int {
	if len(args) == 0 || args[0] == "help" || args[0] == "--help" {
		printThothHelp(stdout)
		return 0
	}
	switch args[0] {
	case "list":
		return runThothList(args[1:], stdout, stderr)
	case "route":
		return runThothRoute(args[1:], stdout, stderr)
	case "explain":
		return runThothExplain(args[1:], stdout, stderr)
	case "show":
		return runThothShow(args[1:], stdout, stderr)
	case "inspect":
		return runThothInspect(args[1:], stdout, stderr)
	case "validate":
		return runThothValidate(args[1:], stdout, stderr)
	case "doctor":
		return runThothDoctor(args[1:], stdout, stderr)
	default:
		fmt.Fprintf(stderr, "unknown thoth command: %s\n", args[0])
		return 1
	}
}

func runSkillAlias(args []string, stdout io.Writer, stderr io.Writer) int {
	if len(args) == 0 || args[0] == "help" || args[0] == "--help" {
		fmt.Fprintln(stdout, "LMTI Skill aliases")
		fmt.Fprintln(stdout, "Usage: lmti skill <list|route|show> [args]")
		return 0
	}
	switch args[0] {
	case "list":
		return runThoth(append([]string{"list"}, args[1:]...), stdout, stderr)
	case "route":
		return runThoth(append([]string{"route"}, args[1:]...), stdout, stderr)
	case "show":
		return runThoth(append([]string{"show"}, args[1:]...), stdout, stderr)
	case "validate":
		return runThoth(append([]string{"validate"}, args[1:]...), stdout, stderr)
	default:
		fmt.Fprintf(stderr, "unknown skill alias: %s\n", args[0])
		return 4
	}
}

func runThothList(args []string, stdout io.Writer, stderr io.Writer) int {
	registry, ok := loadThothRegistry(stdout, stderr, hasFlag(args, "--json"), "lmti.thoth.list")
	if !ok {
		return 1
	}
	if hasFlag(args, "--json") {
		_ = thoth.WriteJSON(stdout, "lmti.thoth.list", thoth.StatusPass, nil, nil, map[string]any{"skills": registry.Skills})
		return 0
	}
	fmt.Fprintln(stdout, "Available skills")
	fmt.Fprintln(stdout)
	fmt.Fprintln(stdout, "| Skill | Intent | Risk | Policy | Memory |")
	fmt.Fprintln(stdout, "|---|---|---|---|---|")
	for _, skill := range registry.Skills {
		fmt.Fprintf(stdout, "| %s | %s | %s | %s | %s |\n",
			skill.ID,
			strings.Join(skill.Intents, ", "),
			skill.RiskLevel,
			yesNo(skill.RequiresPolicy),
			yesNo(skill.RequiresMemory),
		)
	}
	return 0
}

func runThothRoute(args []string, stdout io.Writer, stderr io.Writer) int {
	jsonOutput := hasFlag(args, "--json")
	request := positionalText(args)
	if request == "" {
		return thothUsageError(stdout, stderr, jsonOutput, "lmti.thoth.route", `Usage: lmti thoth route "<user request>" [--json]`)
	}
	registry, ok := loadThothRegistry(stdout, stderr, jsonOutput, "lmti.thoth.route")
	if !ok {
		return 1
	}
	outcome := thoth.NewRouter(registry).Route(request)
	if jsonOutput {
		_ = thoth.WriteJSON(stdout, "lmti.thoth.route", outcome.Status, outcome.Warnings, outcome.Errors, outcome.Result)
		return thothExit(outcome.Status)
	}
	printRoute(stdout, outcome)
	return thothExit(outcome.Status)
}

func runThothExplain(args []string, stdout io.Writer, stderr io.Writer) int {
	jsonOutput := hasFlag(args, "--json")
	request := positionalText(args)
	if request == "" {
		return thothUsageError(stdout, stderr, jsonOutput, "lmti.thoth.explain", `Usage: lmti thoth explain "<user request>" [--json]`)
	}
	registry, ok := loadThothRegistry(stdout, stderr, jsonOutput, "lmti.thoth.explain")
	if !ok {
		return 1
	}
	outcome := thoth.NewRouter(registry).Route(request)
	explanation := thoth.Explain(outcome)
	if jsonOutput {
		_ = thoth.WriteJSON(stdout, "lmti.thoth.explain", outcome.Status, outcome.Warnings, outcome.Errors, explanation)
		return thothExit(outcome.Status)
	}
	fmt.Fprintln(stdout, "Request:")
	fmt.Fprintln(stdout, explanation.Request)
	fmt.Fprintln(stdout)
	fmt.Fprintln(stdout, "Detected intent:")
	fmt.Fprintln(stdout, explanation.DetectedIntent)
	fmt.Fprintln(stdout)
	fmt.Fprintln(stdout, "Selected skill:")
	if explanation.SelectedSkill == "" {
		fmt.Fprintln(stdout, "none")
	} else {
		fmt.Fprintln(stdout, explanation.SelectedSkill)
	}
	fmt.Fprintln(stdout)
	fmt.Fprintln(stdout, "Why:")
	fmt.Fprintln(stdout, explanation.Why)
	fmt.Fprintln(stdout)
	fmt.Fprintln(stdout, "Recommended flow:")
	for index, step := range explanation.RecommendedFlow {
		fmt.Fprintf(stdout, "%d. %s\n", index+1, step)
	}
	return thothExit(outcome.Status)
}

func runThothShow(args []string, stdout io.Writer, stderr io.Writer) int {
	jsonOutput := hasFlag(args, "--json")
	id := firstPositional(args)
	if id == "" {
		return thothUsageError(stdout, stderr, jsonOutput, "lmti.thoth.show", "Usage: lmti thoth show <skill-id> [--json]")
	}
	registry, ok := loadThothRegistry(stdout, stderr, jsonOutput, "lmti.thoth.show")
	if !ok {
		return 1
	}
	content, warnings, errors := thoth.LoadSkill(".", registry, id)
	status := thoth.StatusPass
	if len(warnings) > 0 {
		status = thoth.StatusWarn
	}
	if len(errors) > 0 {
		status = thoth.StatusError
	}
	if jsonOutput {
		_ = thoth.WriteJSON(stdout, "lmti.thoth.show", status, warnings, errors, content)
		return thothExit(status)
	}
	if len(errors) > 0 {
		for _, msg := range errors {
			fmt.Fprintf(stderr, "%s: %s\n", msg.Code, msg.Message)
		}
		return 1
	}
	for _, msg := range warnings {
		fmt.Fprintf(stderr, "warning %s: %s\n", msg.Code, msg.Message)
	}
	fmt.Fprint(stdout, content.Content)
	if !strings.HasSuffix(content.Content, "\n") {
		fmt.Fprintln(stdout)
	}
	return thothExit(status)
}

func runThothInspect(args []string, stdout io.Writer, stderr io.Writer) int {
	jsonOutput := hasFlag(args, "--json")
	id := firstPositional(args)
	if id == "" {
		return thothUsageError(stdout, stderr, jsonOutput, "lmti.thoth.inspect", "Usage: lmti thoth inspect <skill-id> [--json]")
	}
	registry, ok := loadThothRegistry(stdout, stderr, jsonOutput, "lmti.thoth.inspect")
	if !ok {
		return 1
	}
	inspection := thoth.InspectSkill(".", registry, id)
	status := thoth.StatusPass
	if inspection.Status == "warn" {
		status = thoth.StatusWarn
	}
	if inspection.Status == "invalid" {
		status = thoth.StatusError
	}
	if jsonOutput {
		_ = thoth.WriteJSON(stdout, "lmti.thoth.inspect", status, inspection.Warnings, inspection.Errors, inspection)
		return thothExit(status)
	}
	if inspection.Status == "invalid" {
		for _, msg := range inspection.Errors {
			fmt.Fprintf(stderr, "%s: %s\n", msg.Code, msg.Message)
		}
		return 1
	}
	fmt.Fprintf(stdout, "Skill: %s\n", inspection.Skill.ID)
	fmt.Fprintf(stdout, "File: %s\n", inspection.Skill.File)
	fmt.Fprintf(stdout, "Risk: %s\n", inspection.Skill.RiskLevel)
	fmt.Fprintf(stdout, "Requires policy: %s\n", yesNo(inspection.Skill.RequiresPolicy))
	fmt.Fprintf(stdout, "Requires memory: %s\n", yesNo(inspection.Skill.RequiresMemory))
	fmt.Fprintf(stdout, "Intents: %s\n", strings.Join(inspection.Skill.Intents, ", "))
	fmt.Fprintf(stdout, "Status: %s\n", inspection.Status)
	return thothExit(status)
}

func runThothValidate(args []string, stdout io.Writer, _ io.Writer) int {
	report := thoth.Validate(".")
	status := statusFromReport(report.Result)
	if hasFlag(args, "--json") {
		_ = thoth.WriteJSON(stdout, "lmti.thoth.validate", status, nil, nil, report)
		return thothExit(status)
	}
	fmt.Fprintln(stdout, "Thoth validation")
	fmt.Fprintln(stdout)
	printChecks(stdout, report.Checks)
	fmt.Fprintf(stdout, "\nResult: %s\n", report.Result)
	return thothExit(status)
}

func runThothDoctor(args []string, stdout io.Writer, _ io.Writer) int {
	report := thoth.Doctor(".")
	status := statusFromReport(report.Result)
	if hasFlag(args, "--json") {
		_ = thoth.WriteJSON(stdout, "lmti.thoth.doctor", status, nil, nil, report)
		return thothExit(status)
	}
	fmt.Fprintln(stdout, "Thoth doctor")
	fmt.Fprintln(stdout)
	printChecks(stdout, report.Checks)
	fmt.Fprintf(stdout, "\nResult: %s\n", report.Result)
	return thothExit(status)
}

func printThothHelp(stdout io.Writer) {
	fmt.Fprintln(stdout, "LMTI Thoth - skill routing")
	fmt.Fprintln(stdout, "Usage: lmti thoth <list|route|explain|show|inspect|validate|doctor> [args] [--json]")
	fmt.Fprintln(stdout, "Aliases: lmti skill <list|route|show>")
}

func loadThothRegistry(stdout io.Writer, stderr io.Writer, jsonOutput bool, command string) (thoth.Registry, bool) {
	registry, err := thoth.LoadRegistry(".")
	if err == nil {
		return registry, true
	}
	msg := thoth.Message{Code: thoth.ErrRegistryMissing, Message: err.Error()}
	if jsonOutput {
		_ = thoth.WriteJSON(stdout, command, thoth.StatusError, nil, []thoth.Message{msg}, map[string]any{})
	} else {
		fmt.Fprintf(stderr, "%s: %s\n", msg.Code, msg.Message)
	}
	return thoth.Registry{}, false
}

func printRoute(stdout io.Writer, outcome thoth.RouteOutcome) {
	result := outcome.Result
	fmt.Fprintln(stdout, "Thoth routing result")
	fmt.Fprintln(stdout)
	fmt.Fprintf(stdout, "Intent: %s\n", result.Intent)
	if result.SelectedSkill == nil {
		fmt.Fprintln(stdout, "Selected skill: none")
	} else {
		fmt.Fprintf(stdout, "Selected skill: %s\n", result.SelectedSkill.ID)
		fmt.Fprintf(stdout, "Risk: %s\n", result.SelectedSkill.RiskLevel)
	}
	fmt.Fprintf(stdout, "Policy required: %s\n", yesNo(result.RequiresPolicy))
	fmt.Fprintf(stdout, "Memory required: %s\n", yesNo(result.RequiresMemory))
	fmt.Fprintln(stdout)
	fmt.Fprintln(stdout, "Reason:")
	fmt.Fprintln(stdout, result.Reason)
	if len(result.SecondarySkills) > 0 {
		fmt.Fprintln(stdout)
		fmt.Fprintln(stdout, "Secondary skills:")
		for _, skill := range result.SecondarySkills {
			fmt.Fprintf(stdout, "- %s: %s\n", skill.ID, skill.Reason)
		}
	}
	if len(result.RecommendedCommands) > 0 {
		fmt.Fprintln(stdout)
		fmt.Fprintln(stdout, "Next command:")
		fmt.Fprintln(stdout, result.RecommendedCommands[0])
	}
}

func printChecks(stdout io.Writer, checks []thoth.ValidationCheck) {
	fmt.Fprintln(stdout, "| Check | Status | Detail |")
	fmt.Fprintln(stdout, "|---|---|---|")
	for _, check := range checks {
		fmt.Fprintf(stdout, "| %s | %s | %s |\n", check.Check, check.Status, check.Detail)
	}
}

func thothUsageError(stdout io.Writer, stderr io.Writer, jsonOutput bool, command string, message string) int {
	msg := thoth.Message{Code: thoth.ErrSkillInvalid, Message: message}
	if jsonOutput {
		_ = thoth.WriteJSON(stdout, command, thoth.StatusError, nil, []thoth.Message{msg}, map[string]any{})
	} else {
		fmt.Fprintln(stderr, message)
	}
	return 1
}

func positionalText(args []string) string {
	var parts []string
	skipNext := false
	for _, arg := range args {
		if skipNext {
			skipNext = false
			continue
		}
		if strings.HasPrefix(arg, "--") {
			if !strings.Contains(arg, "=") && flagTakesValue(arg) {
				skipNext = true
			}
			continue
		}
		parts = append(parts, arg)
	}
	return strings.TrimSpace(strings.Join(parts, " "))
}

func flagTakesValue(flag string) bool {
	switch flag {
	case "--title", "--content", "--kind", "--privacy", "--privacy-max", "--source-agent", "--tags", "--limit", "--intent", "--path", "--manifest":
		return true
	default:
		return false
	}
}

func firstPositional(args []string) string {
	for _, arg := range args {
		if !strings.HasPrefix(arg, "--") {
			return arg
		}
	}
	return ""
}

func yesNo(value bool) string {
	if value {
		return "yes"
	}
	return "no"
}

func thothExit(status string) int {
	switch status {
	case thoth.StatusError, thoth.StatusBlocked:
		return 1
	default:
		return 0
	}
}

func statusFromReport(result string) string {
	switch result {
	case "PASS":
		return thoth.StatusPass
	case "PASS WITH WARNINGS":
		return thoth.StatusWarn
	default:
		return thoth.StatusError
	}
}
