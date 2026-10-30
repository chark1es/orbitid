import type { PermissionJSON, RoleJSON } from "@orbitid/shared";

export class Permission {
  readonly object = "permission" as const;
  id: string;
  key: string;
  name: string;
  description: string;
  type: "system" | "user";
  createdAt: number;
  updatedAt: number;

  constructor(json: PermissionJSON) {
    this.id = json.id;
    this.key = json.key;
    this.name = json.name;
    this.description = json.description;
    this.type = json.type;
    this.createdAt = json.created_at;
    this.updatedAt = json.updated_at;
  }

  static fromJSON(json: PermissionJSON): Permission {
    return new Permission(json);
  }
}

export class Role {
  readonly object = "role" as const;
  id: string;
  key: string;
  name: string;
  description: string;
  isCreatorEligible: boolean;
  permissions: Permission[];
  createdAt: number;
  updatedAt: number;

  constructor(json: RoleJSON) {
    this.id = json.id;
    this.key = json.key;
    this.name = json.name;
    this.description = json.description;
    this.isCreatorEligible = json.is_creator_eligible ?? false;
    this.permissions = (json.permissions ?? []).map(Permission.fromJSON);
    this.createdAt = json.created_at;
    this.updatedAt = json.updated_at;
  }

  static fromJSON(json: RoleJSON): Role {
    return new Role(json);
  }
}
