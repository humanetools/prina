/** Users (P11) — user list, creation with role assignment, and editing other accounts (admin · instance creator) */
import { useState } from "react";
import { IconPlus } from "@tabler/icons-react";
import { api, apiErrorMessage } from "../../api/client";
import type { UserRow } from "../../api/types";
import { useAuth } from "../../auth/AuthProvider";
import { useInvalidatingMutation, useRoles, useUsers } from "../../hooks/queries";
import { Modal } from "../../components/common/Modal";
import { DataTable } from "../../components/common/DataTable";

export function UsersPage() {
  const [userModal, setUserModal] = useState(false);
  return (
    <>
      <div className="page-head">
        <h1>Users</h1>
        <button className="btn btn-primary" onClick={() => setUserModal(true)}>
          <IconPlus size="1.5rem" /> Add user
        </button>
      </div>
      <UserList />
      {userModal && <CreateUserModal onClose={() => setUserModal(false)} />}
    </>
  );
}

function UserList() {
  const { data: users } = useUsers();
  const { data: roles } = useRoles();
  const { state } = useAuth();
  const me = state.status === "authed" ? state.me.user : null;
  const [editing, setEditing] = useState<UserRow | null>(null);
  // The instance creator's account is editable only by the instance creator (the server enforces it too)
  const canEdit = (u: UserRow) => !u.isInstanceAdmin || me?.isInstanceAdmin === true;
  const roleNames = (roleIds: string[]) =>
    roleIds.map((id) => roles?.find((r) => r.id === id)?.name ?? id).join(", ") || "—";
  return (
    <section style={{ marginTop: "var(--space-5)" }}>
      <h3 className="section-title">User</h3>
      <DataTable
        columns={[
          {
            key: "name",
            title: "Name",
            sortValue: (u) => u.name,
            render: (u) => (
              <>
                {u.name}
                {u.isInstanceAdmin && <span className="chip chip-sm">Instance admin</span>}
                {!u.isActive && <span className="chip chip-sm warn">Inactive</span>}
              </>
            ),
          },
          { key: "username", title: "Username", sortValue: (u) => u.username, render: (u) => u.username },
          { key: "role", title: "Role", sortValue: (u) => roleNames(u.roleIds), render: (u) => roleNames(u.roleIds) },
        ]}
        rows={users ?? []}
        rowKey={(u) => u.id}
        emptyText="No users"
        onRowClick={(u) => { if (canEdit(u)) setEditing(u); }}
      />
      {editing && <EditUserModal user={editing} isSelf={editing.id === me?.id} onClose={() => setEditing(null)} />}
    </section>
  );
}

/** Edit another account — name, username, password reset, roles, active (PUT /api/users/:id) */
function EditUserModal({ user, isSelf, onClose }: { user: UserRow; isSelf: boolean; onClose(): void }) {
  const { data: roles } = useRoles();
  const [form, setForm] = useState({ name: user.name, username: user.username, password: "", roleIds: user.roleIds, isActive: user.isActive });
  const [error, setError] = useState<string | null>(null);
  const save = useInvalidatingMutation(
    () => {
      const body: Record<string, unknown> = { name: form.name, username: form.username, roleIds: form.roleIds, isActive: form.isActive };
      if (form.password) body.password = form.password;
      return api(`/api/users/${user.id}`, { method: "PUT", body });
    },
    [["users"]],
  );
  const passwordOk = form.password === "" || form.password.length >= 8;
  return (
    <Modal title={`Edit user — ${user.name}`} onClose={onClose}>
      <div className="form-fields">
        <label className="field"><span>Name</span>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label className="field"><span>Username — lowercase letters, digits, . _ - (no email)</span>
          <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value.toLowerCase() })} /></label>
        <label className="field"><span>New temporary password — leave empty to keep (8+ characters; signs the user out, who must change it at next sign-in)</span>
          <input type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>
        {!user.isInstanceAdmin && (
          <div className="field"><span>Role</span>
            {(roles ?? []).map((r) => (
              <label key={r.id} className="check">
                <input type="checkbox" checked={form.roleIds.includes(r.id)}
                  onChange={(e) =>
                    setForm({ ...form, roleIds: e.target.checked ? [...form.roleIds, r.id] : form.roleIds.filter((x) => x !== r.id) })
                  } />
                {r.name}
              </label>
            ))}
          </div>
        )}
        <label className="check" title={isSelf ? "You cannot deactivate your own account" : undefined}>
          <input type="checkbox" checked={form.isActive} disabled={isSelf} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />
          Active — inactive users cannot sign in
        </label>
        {error && <div className="form-error">{error}</div>}
        <button className="btn btn-primary btn-block"
          disabled={!form.name || !form.username || !passwordOk || save.isPending}
          onClick={() => save.mutate(undefined, { onSuccess: onClose, onError: (e) => setError(apiErrorMessage(e, "failed")) })}>
          Save
        </button>
      </div>
    </Modal>
  );
}

function CreateUserModal({ onClose }: { onClose(): void }) {
  const { data: roles } = useRoles();
  const [form, setForm] = useState({ name: "", username: "", password: "", roleIds: [] as string[] });
  const [error, setError] = useState<string | null>(null);
  const create = useInvalidatingMutation(
    () => api("/api/users", { method: "POST", body: form }),
    [["users"]],
  );

  return (
    <Modal title="Add user" onClose={onClose}>
      <div className="form-fields">
        <label className="field"><span>Name</span>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label className="field"><span>Username — lowercase letters, digits, . _ - (no email)</span>
          <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value.toLowerCase() })} placeholder="jane" /></label>
        <label className="field"><span>Temporary password (8+ characters) — the user must change it at first sign-in</span>
          <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>
        <div className="field"><span>Role</span>
          {(roles ?? []).map((r) => (
            <label key={r.id} className="check">
              <input type="checkbox" checked={form.roleIds.includes(r.id)}
                onChange={(e) =>
                  setForm({
                    ...form,
                    roleIds: e.target.checked
                      ? [...form.roleIds, r.id]
                      : form.roleIds.filter((x) => x !== r.id),
                  })
                } />
              {r.name}
            </label>
          ))}
        </div>
        {error && <div className="form-error">{error}</div>}
        <button className="btn btn-primary btn-block"
          disabled={!form.name || !form.username || form.password.length < 8}
          onClick={() =>
            create.mutate(undefined, {
              onSuccess: onClose,
              onError: (e) => setError(apiErrorMessage(e, "failed")),
            })
          }>
          Add
        </button>
      </div>
    </Modal>
  );
}
