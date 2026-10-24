// Bounded local operator DTO vocabulary. Native validation is authoritative.
export const contentCollections = [
  {
    "id": "project",
    "label": "Project details",
    "vi": "Thông tin dự án",
    "fields": [
      {
        "id": "id",
        "type": "text"
      },
      {
        "id": "label",
        "type": "text"
      },
      {
        "id": "goal",
        "type": "text"
      },
      {
        "id": "privacy",
        "type": "select",
        "options": [
          "internal",
          "public"
        ]
      }
    ]
  },
  {
    "id": "repositories",
    "label": "Repositories",
    "vi": "Kho mã nguồn",
    "fields": [
      {
        "id": "id",
        "type": "text"
      },
      {
        "id": "label",
        "type": "text"
      },
      {
        "id": "locator",
        "type": "text"
      },
      {
        "id": "privacy",
        "type": "select",
        "options": [
          "internal",
          "public"
        ]
      }
    ]
  },
  {
    "id": "components",
    "label": "Software components",
    "vi": "Thành phần phần mềm",
    "fields": [
      {
        "id": "id",
        "type": "text"
      },
      {
        "id": "label",
        "type": "text"
      },
      {
        "id": "repositoryId",
        "type": "text"
      },
      {
        "id": "kind",
        "type": "select",
        "options": [
          "firmware",
          "gateway",
          "backend",
          "desktop",
          "driver",
          "library"
        ]
      },
      {
        "id": "privacy",
        "type": "select",
        "options": [
          "internal",
          "public"
        ]
      }
    ]
  },
  {
    "id": "targets",
    "label": "Hardware targets",
    "vi": "Phần cứng đích",
    "fields": [
      {
        "id": "id",
        "type": "text"
      },
      {
        "id": "label",
        "type": "text"
      },
      {
        "id": "hardwareRevision",
        "type": "text"
      },
      {
        "id": "architecture",
        "type": "text"
      },
      {
        "id": "privacy",
        "type": "select",
        "options": [
          "internal",
          "public"
        ]
      }
    ]
  },
  {
    "id": "releases",
    "label": "Software releases",
    "vi": "Phiên bản phần mềm",
    "fields": [
      {
        "id": "id",
        "type": "text"
      },
      {
        "id": "label",
        "type": "text"
      },
      {
        "id": "componentId",
        "type": "text"
      },
      {
        "id": "targetId",
        "type": "text"
      },
      {
        "id": "sourceRevision",
        "type": "text"
      },
      {
        "id": "state",
        "type": "select",
        "options": [
          "draft",
          "candidate",
          "approved",
          "archived"
        ]
      },
      {
        "id": "privacy",
        "type": "select",
        "options": [
          "internal",
          "public"
        ]
      }
    ]
  },
  {
    "id": "bindings",
    "label": "Software bindings",
    "vi": "Liên kết phần mềm",
    "fields": [
      {
        "id": "id",
        "type": "text"
      },
      {
        "id": "assetId",
        "type": "text"
      },
      {
        "id": "componentId",
        "type": "text"
      },
      {
        "id": "releaseId",
        "type": "text"
      },
      {
        "id": "targetId",
        "type": "text"
      },
      {
        "id": "privacy",
        "type": "select",
        "options": [
          "internal",
          "public"
        ]
      }
    ]
  },
  {
    "id": "dependencies",
    "label": "Component dependencies",
    "vi": "Phụ thuộc thành phần",
    "fields": [
      {
        "id": "id",
        "type": "text"
      },
      {
        "id": "from",
        "type": "text"
      },
      {
        "id": "to",
        "type": "text"
      },
      {
        "id": "contract",
        "type": "text"
      },
      {
        "id": "privacy",
        "type": "select",
        "options": [
          "internal",
          "public"
        ]
      }
    ]
  },
  {
    "id": "verification",
    "label": "Verification records",
    "vi": "Bằng chứng kiểm chứng",
    "fields": [
      {
        "id": "id",
        "type": "text"
      },
      {
        "id": "releaseId",
        "type": "text"
      },
      {
        "id": "assetId",
        "type": "text"
      },
      {
        "id": "evidence",
        "type": "text"
      },
      {
        "id": "source",
        "type": "text"
      },
      {
        "id": "at",
        "type": "number"
      },
      {
        "id": "result",
        "type": "select",
        "options": [
          "operator-declared",
          "passed",
          "failed"
        ]
      },
      {
        "id": "privacy",
        "type": "select",
        "options": [
          "internal",
          "public"
        ]
      }
    ]
  },
  {
    "id": "milestones",
    "label": "Milestones",
    "vi": "Mốc công việc",
    "fields": [
      {
        "id": "id",
        "type": "text"
      },
      {
        "id": "label",
        "type": "text"
      },
      {
        "id": "criteria",
        "type": "text"
      },
      {
        "id": "dueDate",
        "type": "text"
      },
      {
        "id": "accepted",
        "type": "boolean"
      },
      {
        "id": "evidence",
        "type": "text"
      },
      {
        "id": "privacy",
        "type": "select",
        "options": [
          "internal",
          "public"
        ]
      }
    ]
  },
  {
    "id": "work",
    "label": "Work items",
    "vi": "Công việc",
    "fields": [
      {
        "id": "id",
        "type": "text"
      },
      {
        "id": "label",
        "type": "text"
      },
      {
        "id": "componentId",
        "type": "text"
      },
      {
        "id": "assetId",
        "type": "text"
      },
      {
        "id": "releaseId",
        "type": "text"
      },
      {
        "id": "milestoneId",
        "type": "text"
      },
      {
        "id": "checklist",
        "type": "text"
      },
      {
        "id": "evidence",
        "type": "text"
      },
      {
        "id": "kind",
        "type": "select",
        "options": [
          "task",
          "bug",
          "integration",
          "validation"
        ]
      },
      {
        "id": "state",
        "type": "select",
        "options": [
          "todo",
          "in-progress",
          "review",
          "done",
          "blocked"
        ]
      },
      {
        "id": "privacy",
        "type": "select",
        "options": [
          "internal",
          "public"
        ]
      }
    ]
  },
  {
    "id": "knowledge",
    "label": "Knowledge references",
    "vi": "Tham chiếu tri thức",
    "fields": [
      {
        "id": "id",
        "type": "text"
      },
      {
        "id": "label",
        "type": "text"
      },
      {
        "id": "componentId",
        "type": "text"
      },
      {
        "id": "reference",
        "type": "text"
      },
      {
        "id": "fingerprint",
        "type": "text"
      },
      {
        "id": "privacy",
        "type": "select",
        "options": [
          "internal",
          "public"
        ]
      }
    ]
  },
  {
    "id": "assets",
    "label": "Devices and services",
    "vi": "Thiết bị và dịch vụ",
    "fields": [
      {
        "id": "id",
        "type": "text"
      },
      {
        "id": "label",
        "type": "text"
      },
      {
        "id": "site",
        "type": "text"
      },
      {
        "id": "kind",
        "type": "select",
        "options": [
          "machine",
          "gateway",
          "broker",
          "service",
          "sensor"
        ]
      },
      {
        "id": "privacy",
        "type": "select",
        "options": [
          "internal",
          "public"
        ]
      },
      {
        "id": "enabled",
        "type": "boolean"
      },
      {
        "id": "pollMs",
        "type": "number"
      }
    ]
  },
  {
    "id": "connections",
    "label": "Declared connections",
    "vi": "Kết nối khai báo",
    "fields": [
      {
        "id": "id",
        "type": "text"
      },
      {
        "id": "from",
        "type": "text"
      },
      {
        "id": "to",
        "type": "text"
      },
      {
        "id": "protocol",
        "type": "select",
        "options": [
          "dependency",
          "mqtt",
          "opcua",
          "modbus-tcp"
        ]
      }
    ]
  }
] as const;
export type ContentCollection = typeof contentCollections[number]['id'];
export type ContentRecord = Record<string,string|number|boolean>;
export interface ContentPage {collection:ContentCollection;revision:number;items:ContentRecord[];total:number;nextOffset:number|null}
export interface ContentChange {collection:ContentCollection;operation:'add'|'update'|'remove';expectedRevision:number;record:ContentRecord}
