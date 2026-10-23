cmake_minimum_required(VERSION 3.24)
project(LmtiTopology VERSION 0.2.0 LANGUAGES CXX)
set(LMTI_RELEASE_VERSION "0.2.0-alpha.1")
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")
option(LMTI_BUILD_TESTS "Build topology tests" ON)
if(LMTI_BUILD_TESTS)
  enable_testing()
endif()
add_subdirectory(native/privacy)
if(MSVC)
  add_compile_options(/W4 /permissive- /utf-8)
else()
  add_compile_options(-Wall -Wextra -Wpedantic)
endif()
add_library(lmti_topology_core native/core/model.cpp)
target_include_directories(lmti_topology_core PUBLIC native/include)

# 6.12 includes the fixes for Qt's published 2026 XML advisories.
find_package(Qt6 6.12 REQUIRED COMPONENTS Core Sql)
add_library(lmti_topology_storage native/storage/sqlite_store.cpp native/storage/boundary.cpp)
target_link_libraries(lmti_topology_storage PUBLIC lmti_topology_core Qt6::Core Qt6::Sql)
add_library(lmti_project_core native/core/project.cpp native/core/project_hierarchy.cpp
  native/core/project_physical_hierarchy.cpp native/core/project_desired_asset.cpp)
target_link_libraries(lmti_project_core PUBLIC lmti_topology_core)
add_library(lmti_project_storage native/storage/project_store.cpp native/storage/project_boundary.cpp
  native/storage/project_structure_boundary.cpp
  native/storage/project_mapping_observation.cpp
  native/storage/project_copy.cpp
  native/storage/project_library.cpp)
target_link_libraries(lmti_project_storage PUBLIC lmti_project_core lmti_topology_storage)
add_library(lmti_mcp_profile_core native/core/mcp_profile.cpp)
target_link_libraries(lmti_mcp_profile_core PUBLIC lmti_topology_core)
add_library(lmti_mcp_profile_storage native/storage/mcp_profile_store.cpp)
target_link_libraries(lmti_mcp_profile_storage PUBLIC lmti_mcp_profile_core Qt6::Core Qt6::Sql)
add_executable(lmti-topology native/cli/main.cpp)
target_link_libraries(lmti-topology PRIVATE lmti_topology_storage)
add_executable(lmti-project native/cli/project_main.cpp
  native/cli/project_mapping_observation.cpp native/cli/project_desired_asset.cpp)
target_link_libraries(lmti-project PRIVATE lmti_project_storage)
add_executable(lmti-mcp-admin native/cli/mcp_admin.cpp native/cli/project_operations.cpp
  native/cli/project_operation_writes.cpp native/cli/logical_hierarchy.cpp native/cli/physical_hierarchy.cpp
  native/storage/project_original_read.cpp
  native/cli/project_upgrade_recovery.cpp native/cli/original_binding_read.cpp
  native/storage/mcp_original_read.cpp native/storage/original_read.cpp)
target_link_libraries(lmti-mcp-admin PRIVATE lmti_project_storage lmti_mcp_profile_storage)


install(TARGETS lmti-topology RUNTIME DESTINATION bin)
qt_generate_deploy_app_script(TARGET lmti-topology OUTPUT_SCRIPT cli_deploy NO_UNSUPPORTED_PLATFORM_ERROR
  NO_TRANSLATIONS EXCLUDE_PLUGINS qsqlibase qsqlmimer qsqloci qsqlodbc qsqlpsql)
install(SCRIPT ${cli_deploy})
install(TARGETS lmti-project RUNTIME DESTINATION bin)
install(TARGETS lmti-mcp-admin RUNTIME DESTINATION bin)
install(FILES scripts/lmti-agent-mcp.py scripts/mcp-config-owner.py scripts/agent-read-owner.py DESTINATION share/lmti/scripts)
install(FILES docs/project-mcp.md DESTINATION share/lmti)
install(FILES docs/adr/2026-10-13-project-mcp-profile.md DESTINATION share/lmti/adr)
install(FILES docs/plans/2026-10-13-project-mcp-execution.md DESTINATION share/lmti/plans)
install(DIRECTORY python/src/ DESTINATION share/lmti/python/src FILES_MATCHING PATTERN "*.py" PATTERN "__pycache__" EXCLUDE)
qt_generate_deploy_app_script(TARGET lmti-project OUTPUT_SCRIPT project_deploy NO_UNSUPPORTED_PLATFORM_ERROR
  NO_TRANSLATIONS EXCLUDE_PLUGINS qsqlibase qsqlmimer qsqloci qsqlodbc qsqlpsql)
install(SCRIPT ${project_deploy})
install(FILES LICENSE docs/topology-studio.md docs/project-studio.md docs/impact-review.md docs/google-drive.md DESTINATION share/lmti)
install(FILES docs/adr/2026-10-11-project-document.md docs/adr/2026-10-12-desktop-knowledge.md
  docs/adr/2026-10-13-native-impact-review.md docs/adr/2026-10-13-google-drive.md DESTINATION share/lmti/adr)
install(FILES docs/plans/2026-10-11-project-execution.md
  docs/plans/2026-10-11-software-hardware-projects.md
  docs/plans/2026-10-12-project-library.md docs/plans/2026-10-12-library-execution.md
  docs/plans/2026-10-12-ui-optimization.md docs/plans/2026-10-12-ui-execution.md
  docs/plans/2026-10-12-ui-refinement.md
  docs/plans/2026-10-13-native-impact-review.md
  docs/plans/2026-10-13-google-drive.md
  docs/plans/2026-10-13-simple-studio.md
  DESTINATION share/lmti/plans)
set(qt_sbom "${Qt6_DIR}/../../../sbom/qtbase-${Qt6_VERSION}.spdx.json")
if(EXISTS "${qt_sbom}")
  install(FILES "${qt_sbom}" DESTINATION share/lmti/third-party)
endif()

if(LMTI_BUILD_TESTS)
  add_executable(lmti-core-tests native/tests/core_tests.cpp)
  target_link_libraries(lmti-core-tests PRIVATE lmti_topology_core)
  add_test(NAME topology_core COMMAND lmti-core-tests)
  add_executable(lmti-storage-tests native/tests/storage_tests.cpp)
  target_link_libraries(lmti-storage-tests PRIVATE lmti_topology_storage)
  add_test(NAME topology_storage COMMAND lmti-storage-tests)
  add_executable(lmti-project-tests native/tests/project_tests.cpp)
  target_link_libraries(lmti-project-tests PRIVATE lmti_project_storage)
  add_test(NAME project_domain_storage COMMAND lmti-project-tests)
  add_executable(lmti-project-setup-tests native/tests/project_setup_tests.cpp)
  target_link_libraries(lmti-project-setup-tests PRIVATE lmti_project_storage)
  add_dependencies(lmti-project-setup-tests lmti-project)
  add_test(NAME project_operator_setup COMMAND lmti-project-setup-tests $<TARGET_FILE:lmti-project>)
  set_tests_properties(project_operator_setup PROPERTIES TIMEOUT 60)
  # Test-only fault points are absent from the shipped storage library.
  add_executable(lmti-project-library-generation-tests native/tests/project_library_generation_tests.cpp
    native/storage/project_library.cpp native/storage/project_store.cpp native/storage/project_copy.cpp)
  target_compile_definitions(lmti-project-library-generation-tests PRIVATE LMTI_LIBRARY_CORE_TEST_HOOKS)
  target_link_libraries(lmti-project-library-generation-tests PRIVATE lmti_project_core lmti_topology_storage)
  add_test(NAME project_library_generation COMMAND lmti-project-library-generation-tests)
  add_executable(lmti-project-library-activation-tests native/tests/project_library_activation_tests.cpp
    native/storage/project_library.cpp native/storage/project_store.cpp native/storage/project_copy.cpp)
  target_compile_definitions(lmti-project-library-activation-tests PRIVATE LMTI_LIBRARY_CORE_TEST_HOOKS)
  target_link_libraries(lmti-project-library-activation-tests PRIVATE lmti_project_core lmti_topology_storage)
  add_test(NAME project_library_activation COMMAND lmti-project-library-activation-tests)
  add_executable(lmti-project-hierarchy-tests native/tests/project_hierarchy_tests.cpp)
  target_link_libraries(lmti-project-hierarchy-tests PRIVATE lmti_project_core)
  add_test(NAME project_hierarchy_domain COMMAND lmti-project-hierarchy-tests)
  # The reviewed hierarchy fault hooks are compiled only into this isolated test.
  add_executable(lmti-project-hierarchy-owner-tests native/tests/project_hierarchy_owner_tests.cpp
    native/storage/project_store.cpp native/storage/project_copy.cpp
    native/storage/project_boundary.cpp native/storage/project_structure_boundary.cpp)
  target_compile_definitions(lmti-project-hierarchy-owner-tests PRIVATE LMTI_HIERARCHY_OWNER_TEST_HOOKS)
  target_link_libraries(lmti-project-hierarchy-owner-tests PRIVATE lmti_project_core lmti_topology_storage)
  add_test(NAME project_hierarchy_owner COMMAND lmti-project-hierarchy-owner-tests)
  set_tests_properties(project_hierarchy_owner PROPERTIES TIMEOUT 120)
  add_executable(lmti-physical-hierarchy-tests native/tests/physical_hierarchy_tests.cpp)
  target_link_libraries(lmti-physical-hierarchy-tests PRIVATE lmti_project_core)
  add_test(NAME physical_hierarchy_domain COMMAND lmti-physical-hierarchy-tests)
  set_tests_properties(physical_hierarchy_domain PROPERTIES TIMEOUT 120)
  # Physical owner fault points stay in this isolated test, never the shipped library.
  add_executable(lmti-physical-hierarchy-owner-tests native/tests/physical_hierarchy_owner_tests.cpp
    native/storage/project_store.cpp native/storage/project_copy.cpp
    native/storage/project_boundary.cpp native/storage/project_structure_boundary.cpp)
  target_compile_definitions(lmti-physical-hierarchy-owner-tests PRIVATE LMTI_PHYSICAL_HIERARCHY_OWNER_TEST_HOOKS)
  target_link_libraries(lmti-physical-hierarchy-owner-tests PRIVATE lmti_project_core lmti_topology_storage)
  add_test(NAME physical_hierarchy_owner COMMAND lmti-physical-hierarchy-owner-tests)
  set_tests_properties(physical_hierarchy_owner PROPERTIES TIMEOUT 120)
  add_executable(lmti-project-structure-tests native/tests/project_structure_tests.cpp)
  target_link_libraries(lmti-project-structure-tests PRIVATE lmti_project_storage)
  add_test(NAME project_structure_domain COMMAND lmti-project-structure-tests)
  add_executable(lmti-project-structure-storage-tests native/tests/project_structure_storage_tests.cpp)
  target_link_libraries(lmti-project-structure-storage-tests PRIVATE lmti_project_storage)
  add_dependencies(lmti-project-structure-storage-tests lmti-project)
  add_test(NAME project_structure_storage COMMAND lmti-project-structure-storage-tests $<TARGET_FILE:lmti-project>)
  # Isolated build of the same owner sources provides deterministic post-COMMIT
  # faults. Shipped lmti_project_storage never contains this test-only control.
  add_executable(lmti-project-copy-tests native/tests/project_copy_tests.cpp
    native/storage/project_store.cpp native/storage/project_copy.cpp)
  target_compile_definitions(lmti-project-copy-tests PRIVATE LMTI_COPY_OWNER_TEST_HOOKS)
  target_link_libraries(lmti-project-copy-tests PRIVATE lmti_project_core lmti_topology_storage)
  add_test(NAME project_copy_owner COMMAND lmti-project-copy-tests)
  add_executable(lmti-project-copy-discovery-tests native/tests/project_copy_discovery_tests.cpp)
  target_link_libraries(lmti-project-copy-discovery-tests PRIVATE lmti_project_storage)
  add_test(NAME project_copy_discovery COMMAND lmti-project-copy-discovery-tests)
  set_tests_properties(project_copy_discovery PROPERTIES TIMEOUT 120)
  add_executable(lmti-project-operations-tests native/tests/project_operations_tests.cpp)
  target_link_libraries(lmti-project-operations-tests PRIVATE lmti_project_storage)
  add_dependencies(lmti-project-operations-tests lmti-mcp-admin)
  add_test(NAME project_operations_facade COMMAND lmti-project-operations-tests $<TARGET_FILE:lmti-mcp-admin>)
  set_tests_properties(project_operations_facade PROPERTIES TIMEOUT 180)
  # Separate, non-installed admin exercises real owner post-COMMIT faults and
  # facade response failures. The shipped admin/storage omit these controls.
  add_executable(lmti-project-operation-write-test-admin
    native/cli/mcp_admin.cpp native/cli/project_operations.cpp native/cli/project_operation_writes.cpp
    native/cli/logical_hierarchy.cpp native/cli/physical_hierarchy.cpp
  native/storage/project_original_read.cpp native/cli/project_upgrade_recovery.cpp
    native/cli/original_binding_read.cpp native/storage/mcp_original_read.cpp native/storage/original_read.cpp
    native/storage/project_library.cpp native/storage/project_store.cpp native/storage/project_copy.cpp)
  target_compile_definitions(lmti-project-operation-write-test-admin PRIVATE
    LMTI_PROJECT_OPERATION_WRITE_TESTING LMTI_LIBRARY_CORE_TEST_HOOKS LMTI_COPY_OWNER_TEST_HOOKS
    LMTI_LOGICAL_HIERARCHY_FACADE_TESTING LMTI_HIERARCHY_OWNER_TEST_HOOKS
    LMTI_PHYSICAL_HIERARCHY_FACADE_TESTING LMTI_PHYSICAL_HIERARCHY_OWNER_TEST_HOOKS)
  target_link_libraries(lmti-project-operation-write-test-admin PRIVATE
    lmti_project_core lmti_topology_storage lmti_mcp_profile_storage)
  add_executable(lmti-project-operation-writes-tests native/tests/project_operation_writes_tests.cpp)
  target_link_libraries(lmti-project-operation-writes-tests PRIVATE lmti_project_storage)
  add_dependencies(lmti-project-operation-writes-tests lmti-mcp-admin lmti-project-operation-write-test-admin)
  add_test(NAME project_operation_writes_facade COMMAND lmti-project-operation-writes-tests
    $<TARGET_FILE:lmti-mcp-admin> $<TARGET_FILE:lmti-project-operation-write-test-admin>)
  set_tests_properties(project_operation_writes_facade PROPERTIES TIMEOUT 240)
  add_executable(lmti-project-hierarchy-transport-tests native/tests/project_hierarchy_transport_tests.cpp)
  target_link_libraries(lmti-project-hierarchy-transport-tests PRIVATE lmti_project_storage)
  add_dependencies(lmti-project-hierarchy-transport-tests lmti-mcp-admin lmti-project-operation-write-test-admin)
  add_test(NAME project_hierarchy_transport COMMAND lmti-project-hierarchy-transport-tests
    $<TARGET_FILE:lmti-mcp-admin> $<TARGET_FILE:lmti-project-operation-write-test-admin>)
  set_tests_properties(project_hierarchy_transport PROPERTIES TIMEOUT 360)
  add_executable(lmti-physical-hierarchy-transport-tests native/tests/physical_hierarchy_transport_tests.cpp)
  target_link_libraries(lmti-physical-hierarchy-transport-tests PRIVATE lmti_project_storage)
  add_dependencies(lmti-physical-hierarchy-transport-tests lmti-mcp-admin lmti-project-operation-write-test-admin)
  add_test(NAME physical_hierarchy_transport COMMAND lmti-physical-hierarchy-transport-tests
    $<TARGET_FILE:lmti-mcp-admin> $<TARGET_FILE:lmti-project-operation-write-test-admin>)
  set_tests_properties(physical_hierarchy_transport PROPERTIES TIMEOUT 360)
  # Private recovery observation uses real typed owner faults in this isolated
  # test only; the installed admin/storage have no test controls.
  add_executable(lmti-project-upgrade-recovery-tests native/tests/project_upgrade_recovery_tests.cpp
    native/storage/project_library.cpp native/storage/project_store.cpp native/storage/project_copy.cpp)
  target_compile_definitions(lmti-project-upgrade-recovery-tests PRIVATE LMTI_LIBRARY_CORE_TEST_HOOKS)
  target_link_libraries(lmti-project-upgrade-recovery-tests PRIVATE
    lmti_project_core lmti_topology_storage lmti_mcp_profile_storage)
  add_dependencies(lmti-project-upgrade-recovery-tests lmti-mcp-admin)
  add_test(NAME project_upgrade_recovery COMMAND lmti-project-upgrade-recovery-tests
    $<TARGET_FILE:lmti-mcp-admin>)
  set_tests_properties(project_upgrade_recovery PROPERTIES TIMEOUT 240)
  # Conditional reads retain original namespace handles. Deterministic
  # content-open/race hooks are compiled only into this isolated test.
  add_executable(lmti-original-binding-read-tests native/tests/original_binding_read_tests.cpp
    native/storage/mcp_original_read.cpp native/storage/original_read.cpp native/storage/project_store.cpp
    native/storage/project_copy.cpp native/storage/project_library.cpp)
  target_compile_definitions(lmti-original-binding-read-tests PRIVATE LMTI_ORIGINAL_READ_TEST_HOOKS)
  target_link_libraries(lmti-original-binding-read-tests PRIVATE
    lmti_project_core lmti_topology_storage lmti_mcp_profile_storage)
  add_dependencies(lmti-original-binding-read-tests lmti-mcp-admin)
  add_test(NAME original_binding_read COMMAND lmti-original-binding-read-tests
    $<TARGET_FILE:lmti-mcp-admin>)
  set_tests_properties(original_binding_read PROPERTIES TIMEOUT 180)
  # Conditional hierarchy state has no profile storage dependency.
  add_executable(lmti-original-hierarchy-read-tests native/tests/original_hierarchy_read_tests.cpp
    native/storage/original_read.cpp native/storage/project_original_read.cpp
    native/storage/project_store.cpp native/storage/project_copy.cpp native/storage/project_library.cpp)
  target_compile_definitions(lmti-original-hierarchy-read-tests PRIVATE LMTI_ORIGINAL_READ_TEST_HOOKS)
  target_link_libraries(lmti-original-hierarchy-read-tests PRIVATE lmti_project_core lmti_topology_storage)
  add_dependencies(lmti-original-hierarchy-read-tests lmti-mcp-admin)
  add_test(NAME original_hierarchy_read COMMAND lmti-original-hierarchy-read-tests $<TARGET_FILE:lmti-mcp-admin>)
  set_tests_properties(original_hierarchy_read PROPERTIES TIMEOUT 180)
  # Original physical state uses the same held namespace and connection boundary.
  add_executable(lmti-original-physical-hierarchy-read-tests native/tests/original_physical_hierarchy_read_tests.cpp
    native/storage/original_read.cpp native/storage/project_original_read.cpp
    native/storage/project_store.cpp native/storage/project_copy.cpp native/storage/project_library.cpp)
  target_compile_definitions(lmti-original-physical-hierarchy-read-tests PRIVATE LMTI_ORIGINAL_READ_TEST_HOOKS)
  target_link_libraries(lmti-original-physical-hierarchy-read-tests PRIVATE lmti_project_core lmti_topology_storage)
  add_test(NAME original_physical_hierarchy_read COMMAND lmti-original-physical-hierarchy-read-tests)
  set_tests_properties(original_physical_hierarchy_read PROPERTIES TIMEOUT 180)
  # Fixed mapping observations share one identity-gated read snapshot.
  # Original-read hooks exist only in this isolated test executable.
  add_executable(lmti-project-mapping-observation-tests
    native/tests/project_mapping_observation_tests.cpp
    native/storage/project_store.cpp native/storage/project_copy.cpp
    native/storage/project_mapping_observation.cpp native/storage/original_read.cpp
    native/storage/project_boundary.cpp native/storage/project_structure_boundary.cpp)
  target_compile_definitions(lmti-project-mapping-observation-tests PRIVATE LMTI_ORIGINAL_READ_TEST_HOOKS)
  target_link_libraries(lmti-project-mapping-observation-tests PRIVATE lmti_project_core lmti_topology_storage)
  add_dependencies(lmti-project-mapping-observation-tests lmti-project)
  add_test(NAME project_mapping_observation COMMAND lmti-project-mapping-observation-tests
    $<TARGET_FILE:lmti-project>)
  set_tests_properties(project_mapping_observation PROPERTIES TIMEOUT 180)
  # Storage-private held reservations; test hooks never enter shipped storage.
  add_executable(lmti-project-reservation-tests native/tests/project_reservation_tests.cpp
    native/storage/project_store.cpp)
  target_compile_definitions(lmti-project-reservation-tests PRIVATE LMTI_PROJECT_RESERVATION_TEST_HOOKS)
  target_link_libraries(lmti-project-reservation-tests PRIVATE lmti_project_core lmti_topology_storage)
  add_test(NAME project_reservation COMMAND lmti-project-reservation-tests)
  add_executable(lmti-project-structure-snapshot-tests native/tests/project_structure_snapshot_tests.cpp)
  target_link_libraries(lmti-project-structure-snapshot-tests PRIVATE lmti_project_storage)
  add_dependencies(lmti-project-structure-snapshot-tests lmti-project)
  add_test(NAME project_structure_snapshot COMMAND lmti-project-structure-snapshot-tests $<TARGET_FILE:lmti-project>)
  add_executable(lmti-project-desired-asset-domain-tests
    native/tests/project_desired_asset_domain_tests.cpp)
  target_link_libraries(lmti-project-desired-asset-domain-tests PRIVATE lmti_project_core)
  add_test(NAME project_desired_asset_domain COMMAND lmti-project-desired-asset-domain-tests)
  set_tests_properties(project_desired_asset_domain PROPERTIES TIMEOUT 60)

  add_executable(lmti-project-desired-asset-receipt-tests
    native/tests/project_desired_asset_receipt_tests.cpp
    native/storage/project_store.cpp native/storage/project_copy.cpp)
  target_compile_definitions(lmti-project-desired-asset-receipt-tests PRIVATE
    LMTI_DESIRED_ASSET_OWNER_TEST_HOOKS)
  target_link_libraries(lmti-project-desired-asset-receipt-tests PRIVATE
    lmti_project_core lmti_topology_storage Qt6::Core Qt6::Sql)
  add_test(NAME project_desired_asset_receipt COMMAND lmti-project-desired-asset-receipt-tests)
  set_tests_properties(project_desired_asset_receipt PROPERTIES TIMEOUT 180)

  add_executable(lmti-project-desired-asset-process-tests
    native/tests/project_desired_asset_process_tests.cpp)
  target_link_libraries(lmti-project-desired-asset-process-tests PRIVATE
    lmti_project_storage Qt6::Core Qt6::Sql)
  add_dependencies(lmti-project-desired-asset-process-tests lmti-project)
  add_test(NAME project_desired_asset_process COMMAND lmti-project-desired-asset-process-tests
    $<TARGET_FILE:lmti-project>)
  set_tests_properties(project_desired_asset_process PROPERTIES TIMEOUT 180)

  add_executable(lmti-project-proposal-tests native/tests/project_proposal_owner_tests.cpp)
  target_link_libraries(lmti-project-proposal-tests PRIVATE lmti_project_storage)
  add_dependencies(lmti-project-proposal-tests lmti-project)
  add_test(NAME project_proposal_owner COMMAND lmti-project-proposal-tests $<TARGET_FILE:lmti-project>)
  add_executable(lmti-mcp-profile-tests native/tests/mcp_profile_tests.cpp)
  target_link_libraries(lmti-mcp-profile-tests PRIVATE lmti_mcp_profile_storage lmti_project_storage)
  add_test(NAME mcp_profile COMMAND lmti-mcp-profile-tests)
  add_executable(lmti-mcp-integration-export-tests native/tests/mcp_integration_export_tests.cpp)
  target_link_libraries(lmti-mcp-integration-export-tests PRIVATE lmti_mcp_profile_storage lmti_project_storage)
  add_dependencies(lmti-mcp-integration-export-tests lmti-mcp-admin)
  add_test(NAME mcp_integration_export COMMAND lmti-mcp-integration-export-tests $<TARGET_FILE:lmti-mcp-admin>)
  add_executable(lmti-mcp-binding-identity-tests native/tests/mcp_binding_identity_tests.cpp)
  target_link_libraries(lmti-mcp-binding-identity-tests PRIVATE lmti_project_storage lmti_mcp_profile_storage)
  add_dependencies(lmti-mcp-binding-identity-tests lmti-mcp-admin)
  add_test(NAME mcp_binding_identity COMMAND lmti-mcp-binding-identity-tests $<TARGET_FILE:lmti-mcp-admin>)
  set_tests_properties(mcp_binding_identity PROPERTIES TIMEOUT 60)
  add_executable(lmti-project-benchmark native/tests/project_benchmark.cpp)
  target_link_libraries(lmti-project-benchmark PRIVATE lmti_project_storage)
  add_executable(lmti-web-benchmark-fixture native/tests/web_benchmark_fixture.cpp)
  target_link_libraries(lmti-web-benchmark-fixture PRIVATE lmti_project_storage lmti_mcp_profile_storage)
  target_compile_definitions(lmti-web-benchmark-fixture PRIVATE LMTI_INTEROP_BUILD_ROOT="${CMAKE_SOURCE_DIR}/build")
endif()
