package publish

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/vuthuanphat/lmti-atlas/internal/config"
	"github.com/vuthuanphat/lmti-atlas/internal/gitcheck"
	"github.com/vuthuanphat/lmti-atlas/internal/secrets"
	"github.com/vuthuanphat/lmti-atlas/pkg/contract"
)

type Check struct {
	ID      string `json:"id"`
	Status  string `json:"status"`
	Detail  string `json:"detail"`
	Code    string `json:"code,omitempty"`
}

type Report struct {
	Result       string  `json:"result"`
	TargetBranch string `json:"targetBranch"`
	Origin       string `json:"origin"`
	Branch       string `json:"branch"`
	Checks       []Check `json:"checks"`
}

func Preflight(ctx context.Context, root string, cfg config.Config) (Report, []contract.BoundaryMessage, []contract.BoundaryMessage) {
	report := Report{Result: contract.StatusPass, TargetBranch: cfg.Publish.TargetBranch}
	client := gitcheck.Client{Root: root}
	var warnings []contract.BoundaryMessage
	var errors []contract.BoundaryMessage

	repoRoot, err := client.RootPath(ctx)
	if err != nil {
		addError(&report, &errors, "repo identity", contract.ErrorPublishTargetMissing, "Current directory is not a Git repository.")
		return finish(report, warnings, errors)
	}
	report.Checks = append(report.Checks, Check{ID: "repo identity", Status: contract.StatusPass, Detail: repoRoot})

	origin, err := client.Origin(ctx)
	report.Origin = origin
	if err != nil || strings.TrimSpace(origin) == "" {
		addError(&report, &errors, "origin remote", contract.ErrorPublishTargetMissing, "Origin remote is missing.")
	} else if cfg.Publish.PublicRepo != "" && normalizeRemote(origin) != normalizeRemote(cfg.Publish.PublicRepo) {
		addError(&report, &errors, "origin remote", contract.ErrorRemoteOriginMismatch, fmt.Sprintf("origin is %s, expected %s", origin, cfg.Publish.PublicRepo))
	} else {
		report.Checks = append(report.Checks, Check{ID: "origin remote", Status: contract.StatusPass, Detail: origin})
	}

	branch, err := client.Branch(ctx)
	report.Branch = branch
	if err != nil || branch == "" {
		addWarning(&report, &warnings, "current branch", contract.ErrorBranchNotAllowed, "Could not determine current branch.")
	} else if !branchAllowed(branch, cfg.Publish.AllowedPublishBranches) {
		addError(&report, &errors, "allowed branch", contract.ErrorBranchNotAllowed, fmt.Sprintf("Branch %s is not in the allowed publish branch list.", branch))
	} else {
		report.Checks = append(report.Checks, Check{ID: "allowed branch", Status: contract.StatusPass, Detail: branch})
	}

	target := "origin/" + defaultString(cfg.Publish.TargetBranch, "main")
	if _, err := client.MergeBase(ctx, target); err != nil {
		addError(&report, &errors, "branch history", contract.ErrorGitHistoryNoCommonAncestor, "Current branch does not share Git history with "+target+". Recreate the branch from "+target+" before publishing.")
	} else {
		report.Checks = append(report.Checks, Check{ID: "branch history", Status: contract.StatusPass, Detail: "common ancestor exists with " + target})
	}
	if divergence, err := client.AheadBehind(ctx, target); err == nil {
		report.Checks = append(report.Checks, Check{ID: "branch divergence", Status: contract.StatusPass, Detail: divergence})
	} else {
		addWarning(&report, &warnings, "branch divergence", contract.ErrorUnknown, "Could not compute ahead/behind against "+target+".")
	}

	status, err := client.StatusPorcelain(ctx)
	if err != nil {
		addWarning(&report, &warnings, "dirty tree", contract.ErrorWorkingTreeDirty, "Could not inspect working tree.")
	} else if strings.TrimSpace(status) != "" {
		addWarning(&report, &warnings, "dirty tree", contract.ErrorWorkingTreeDirty, "Working tree has uncommitted changes.")
		checkProtectedStatus(status, &report, &errors)
	} else {
		report.Checks = append(report.Checks, Check{ID: "dirty tree", Status: contract.StatusPass, Detail: "Working tree clean"})
	}
	checkTrackedProtected(client, ctx, &report, &errors)

	checkOpenSourceDocs(root, &report, &warnings)
	checkIdentity(root, &report, &errors)

	return finish(report, warnings, errors)
}

func checkTrackedProtected(client gitcheck.Client, ctx context.Context, report *Report, errors *[]contract.BoundaryMessage) {
	files, err := client.TrackedFiles(ctx)
	if err != nil {
		report.Checks = append(report.Checks, Check{ID: "tracked protected files", Status: contract.StatusWarn, Detail: "Could not inspect tracked files", Code: string(contract.ErrorUnknown)})
		return
	}
	for _, file := range strings.Split(files, "\n") {
		if secrets.IsProtectedPath(file) {
			addError(report, errors, "tracked protected files", contract.ErrorProtectedFileDetected, "Protected file is tracked: "+file)
			return
		}
	}
	report.Checks = append(report.Checks, Check{ID: "tracked protected files", Status: contract.StatusPass, Detail: "No protected tracked paths found"})
}

func checkProtectedStatus(status string, report *Report, errors *[]contract.BoundaryMessage) {
	for _, line := range strings.Split(status, "\n") {
		if len(line) < 4 {
			continue
		}
		path := strings.TrimSpace(line[3:])
		if secrets.IsProtectedPath(path) {
			addError(report, errors, "protected files", contract.ErrorProtectedFileDetected, "Protected file appears in Git status metadata: "+path)
			return
		}
	}
	report.Checks = append(report.Checks, Check{ID: "protected files", Status: contract.StatusPass, Detail: "No protected paths in Git status metadata"})
}

func checkOpenSourceDocs(root string, report *Report, warnings *[]contract.BoundaryMessage) {
	required := []string{"README.md", "SECURITY.md"}
	missing := []string{}
	for _, file := range required {
		if _, err := os.Stat(filepath.Join(root, file)); err != nil {
			missing = append(missing, file)
		}
	}
	if _, err := os.Stat(filepath.Join(root, "LICENSE")); err != nil {
		missing = append(missing, "LICENSE")
	}
	if len(missing) > 0 {
		addWarning(report, warnings, "open-source docs", contract.ErrorPublishTargetMissing, "Missing public release docs: "+strings.Join(missing, ", "))
		return
	}
	report.Checks = append(report.Checks, Check{ID: "open-source docs", Status: contract.StatusPass, Detail: "README, LICENSE, and SECURITY are present"})
}

func checkIdentity(root string, report *Report, errors *[]contract.BoundaryMessage) {
	content, err := os.ReadFile(filepath.Join(root, "README.md"))
	if err != nil {
		addError(report, errors, "LMTI identity", contract.ErrorConfigInvalid, "README.md could not be read for identity check.")
		return
	}
	text := string(content)
	if !strings.Contains(text, "independent local AI memory, safety, and skill-routing layer") {
		addError(report, errors, "LMTI identity", contract.ErrorConfigInvalid, "README.md does not clearly state LMTI is an independent local layer.")
		return
	}
	report.Checks = append(report.Checks, Check{ID: "LMTI identity", Status: contract.StatusPass, Detail: "Independent layer wording present"})
}

func finish(report Report, warnings []contract.BoundaryMessage, errors []contract.BoundaryMessage) (Report, []contract.BoundaryMessage, []contract.BoundaryMessage) {
	if len(errors) > 0 {
		report.Result = contract.StatusBlocked
	} else if len(warnings) > 0 {
		report.Result = contract.StatusWarn
	} else {
		report.Result = contract.StatusPass
	}
	return report, warnings, errors
}

func addError(report *Report, errors *[]contract.BoundaryMessage, id string, code contract.ErrorCode, detail string) {
	report.Checks = append(report.Checks, Check{ID: id, Status: contract.StatusBlocked, Detail: detail, Code: string(code)})
	*errors = append(*errors, contract.BoundaryMessage{Code: code, Message: detail})
}

func addWarning(report *Report, warnings *[]contract.BoundaryMessage, id string, code contract.ErrorCode, detail string) {
	report.Checks = append(report.Checks, Check{ID: id, Status: contract.StatusWarn, Detail: detail, Code: string(code)})
	*warnings = append(*warnings, contract.BoundaryMessage{Code: code, Message: detail})
}

func normalizeRemote(remote string) string {
	remote = strings.TrimSpace(strings.TrimSuffix(remote, ".git"))
	remote = strings.ReplaceAll(remote, "git@github.com:", "https://github.com/")
	return remote
}

func branchAllowed(branch string, allowed []string) bool {
	if len(allowed) == 0 {
		return branch == "main"
	}
	for _, pattern := range allowed {
		if strings.HasSuffix(pattern, "/*") {
			if strings.HasPrefix(branch, strings.TrimSuffix(pattern, "*")) {
				return true
			}
			continue
		}
		if branch == pattern {
			return true
		}
	}
	return false
}

func defaultString(value string, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}
