/** Roles (P11) — role list + permission matrix; custom-role CRUD is the EE slot */
import { Fragment, useMemo, useState } from "react";
import { SystemSubjects, type Role } from "../../api/types";
import { useContentTypes, useRoles } from "../../hooks/queries";
import { adminEe } from "../../ee-loader";

const ACTIONS = ["create", "read", "update", "delete", "transition", "publish"];

export function RolesPage() {
  const { data: roles } = useRoles();
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const role = roles?.find((r) => r.id === selectedRoleId) ?? roles?.[0];

  return (
    <>
      <div className="page-head">
        <h1>Roles</h1>
      </div>

      <div className="role-tabs">
        {(roles ?? []).map((r) => (
          <button key={r.id}
            className={r.id === role?.id ? "tab active" : "tab"}
            onClick={() => setSelectedRoleId(r.id)}>
            {r.name}{r.isSystem && <span className="muted"> (default)</span>}
          </button>
        ))}
      </div>

      {adminEe && <adminEe.RoleManagerActions role={role} />}
      {role && <PermissionMatrix role={role} />}
    </>
  );
}

function PermissionMatrix({ role }: { role: Role }) {
  const { data: types } = useContentTypes();

  const subjects = useMemo(() => {
    const content = (types ?? []).map((t) => ({
      key: `content:${t.uid}`,
      label: t.name,
    }));
    const system = Object.entries(SystemSubjects).map(([name, key]) => ({
      key,
      label: name,
    }));
    return [
      { key: "content:*", label: "All content" },
      ...content,
      ...system,
    ];
  }, [types]);

  const allows = (subjectKey: string, action: string): boolean =>
    role.permissions.some(
      (p) =>
        (p.action === "*" || p.action === action) &&
        (p.subject === "*" ||
          p.subject === subjectKey ||
          (p.subject.endsWith(":*") && subjectKey.startsWith(p.subject.slice(0, -1)))),
    );

  const cols = `150px repeat(${ACTIONS.length}, 1fr)`;

  return (
    <section className="settings-card">
      <div style={{ display: "flex", alignItems: "baseline", gap: "1rem", marginBottom: "1.8rem" }}>
        <div className="panel-title" style={{ margin: "0" }}>Permission matrix</div>
        <span className="perm-legend">
          C reate · R ead · U pdate · D elete · T ransition · P ublish — field and locale level via the role API
        </span>
      </div>
      <div className="perm-matrix" style={{ gridTemplateColumns: cols }}>
        <div />
        {ACTIONS.map((a) => (
          <div key={a} className="perm-col-head">{a[0]!.toUpperCase()}</div>
        ))}
        {subjects.map((s) => (
          <Fragment key={s.key}>
            <div className="perm-row-label" title={s.key}>{s.label}</div>
            {ACTIONS.map((a) => (
              <div
                key={a}
                className={allows(s.key, a) ? "perm-cell on" : "perm-cell"}
                title={`${a} ${s.key}`}
              >
                {a[0]!.toUpperCase()}
              </div>
            ))}
          </Fragment>
        ))}
      </div>
    </section>
  );
}
