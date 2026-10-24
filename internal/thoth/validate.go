package thoth

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/vuthuanphat/lmti-atlas/internal/credentialscan"
)

func Validate(root string) ValidationReport {
	report := ValidationReport{Result: "PASS"}
	registry, err := LoadRegistry(root)
	if err != nil {
		report.Result = "ERROR"
		report.Checks = append(report.Checks, ValidationCheck{
			Check:  "Skill registry",
			Status: "ERROR",
			Detail: err.Error(),
		})
		return report
	}
	report.Checks = append(report.Checks, ValidationCheck{
		Check:  "Skill registry",
		Status: "PASS",
		Detail: DefaultRegistryPath + " found",
	})
	report.SkillsChecked = len(registry.Skills)
	addRegistryChecks(root, registry, &report)
	if hasCheckStatus(report, "ERROR") {
		report.Result = "ERROR"
	} else if hasCheckStatus(report, "WARN") {
		report.Result = "PASS WITH WARNINGS"
	}
	return report
}

func addRegistryChecks(root string, registry Registry, report *ValidationReport) {
	seenIDs := map[string]bool{}
	duplicateIDs := []string{}
	for _, skill := range registry.Skills {
		if seenIDs[skill.ID] {
			duplicateIDs = append(duplicateIDs, skill.ID)
		}
		seenIDs[skill.ID] = true
	}
	if len(duplicateIDs) > 0 {
		report.Checks = append(report.Checks, ValidationCheck{
			Check:  "Skill ids",
			Status: "ERROR",
			Detail: "duplicate ids: " + strings.Join(duplicateIDs, ", "),
		})
	} else {
		report.Checks = append(report.Checks, ValidationCheck{
			Check:  "Skill ids",
			Status: "PASS",
			Detail: "No duplicate skill ids",
		})
	}

	missingFiles := []string{}
	missingSections := []string{}
	secretFindings := []string{}
	largeFiles := []string{}
	for _, skill := range registry.Skills {
		path, err := safeJoin(root, skill.File)
		if err != nil {
			missingFiles = append(missingFiles, skill.File)
			continue
		}
		info, err := os.Stat(path)
		if err != nil {
			missingFiles = append(missingFiles, skill.File)
			continue
		}
		if info.Size() > maxSkillBytes {
			largeFiles = append(largeFiles, skill.File)
			continue
		}
		contentBytes, err := os.ReadFile(path)
		if err != nil {
			missingFiles = append(missingFiles, skill.File)
			continue
		}
		content := string(contentBytes)
		if missing := missingRequiredSections(content); len(missing) > 0 {
			missingSections = append(missingSections, fmt.Sprintf("%s missing %s", skill.ID, strings.Join(missing, ", ")))
		}
		if hasSecretLikeContent(content) {
			secretFindings = append(secretFindings, skill.File)
		}
	}
	if len(missingFiles) > 0 {
		report.Checks = append(report.Checks, ValidationCheck{Check: "Skill files", Status: "ERROR", Detail: "missing or unsafe paths: " + strings.Join(missingFiles, ", ")})
	} else {
		report.Checks = append(report.Checks, ValidationCheck{Check: "Skill files", Status: "PASS", Detail: fmt.Sprintf("%d skill files found", len(registry.Skills))})
	}
	if len(missingSections) > 0 {
		report.Checks = append(report.Checks, ValidationCheck{Check: "Required sections", Status: "WARN", Detail: strings.Join(missingSections, "; ")})
	} else {
		report.Checks = append(report.Checks, ValidationCheck{Check: "Required sections", Status: "PASS", Detail: "All skill.md files include required sections"})
	}
	if len(secretFindings) > 0 {
		report.Checks = append(report.Checks, ValidationCheck{Check: "Secret scan", Status: "ERROR", Detail: "secret-like content in " + strings.Join(secretFindings, ", ")})
	} else {
		report.Checks = append(report.Checks, ValidationCheck{Check: "Secret scan", Status: "PASS", Detail: "No secret-like content found"})
	}
	if len(largeFiles) > 0 {
		report.Checks = append(report.Checks, ValidationCheck{Check: "Skill size", Status: "WARN", Detail: "unusually large skill files: " + strings.Join(largeFiles, ", ")})
	} else {
		report.Checks = append(report.Checks, ValidationCheck{Check: "Skill size", Status: "PASS", Detail: "Skill files are within the local-alpha size limit"})
	}
	addDuplicateIntentCheck(registry, report)
	addSchemaCheck(root, report)
	addJSONEnvelopeCheck(report)
}

func addDuplicateIntentCheck(registry Registry, report *ValidationReport) {
	seen := map[string]string{}
	var duplicates []string
	for _, skill := range registry.Skills {
		for _, intent := range skill.Intents {
			canonical := CanonicalIntent(intent)
			key := canonical + ":" + intent
			if previous, ok := seen[key]; ok && previous != skill.ID {
				duplicates = append(duplicates, fmt.Sprintf("%s shared by %s and %s", intent, previous, skill.ID))
			}
			seen[key] = skill.ID
		}
	}
	if len(duplicates) > 0 {
		report.Checks = append(report.Checks, ValidationCheck{Check: "Duplicate intents", Status: "WARN", Detail: strings.Join(duplicates, "; ")})
		return
	}
	report.Checks = append(report.Checks, ValidationCheck{Check: "Duplicate intents", Status: "PASS", Detail: "No dangerous overlap"})
}

func addSchemaCheck(root string, report *ValidationReport) {
	required := []string{
		"schemas/lmti.thoth.schema.json",
		"schemas/lmti.skill.schema.json",
		"schemas/lmti.cli.schema.json",
	}
	var missing []string
	for _, schema := range required {
		path, err := safeJoin(root, schema)
		if err != nil {
			missing = append(missing, schema)
			continue
		}
		if _, err := os.Stat(path); err != nil {
			missing = append(missing, schema)
		}
	}
	if len(missing) > 0 {
		report.Checks = append(report.Checks, ValidationCheck{Check: "Schemas", Status: "WARN", Detail: "missing schemas: " + strings.Join(missing, ", ")})
		return
	}
	report.Checks = append(report.Checks, ValidationCheck{Check: "Schemas", Status: "PASS", Detail: "Thoth, skill, and CLI schemas found"})
}

func addJSONEnvelopeCheck(report *ValidationReport) {
	bytes, err := json.Marshal(Envelope{
		SchemaVersion: SchemaVersion,
		Command:       "lmti.thoth.doctor",
		Status:        StatusPass,
		Data:          map[string]any{"ok": true},
		Warnings:      []Message{},
		Errors:        []Message{},
	})
	if err != nil || !strings.Contains(string(bytes), SchemaVersion) {
		report.Checks = append(report.Checks, ValidationCheck{Check: "JSON output", Status: "ERROR", Detail: "Could not serialize Thoth JSON envelope"})
		return
	}
	report.Checks = append(report.Checks, ValidationCheck{Check: "JSON output", Status: "PASS", Detail: "Thoth envelope serializes as lmti.thoth.v1"})
}

func hasSecretLikeContent(content string) bool {
	return credentialscan.ContainsSecretLikeContent(content)
}

func hasCheckStatus(report ValidationReport, status string) bool {
	for _, check := range report.Checks {
		if check.Status == status {
			return true
		}
	}
	return false
}
