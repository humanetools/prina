/**
 * Users (P11) — user list, creation with role assignment, and editing other accounts (admin · instance creator).
 * 50-IMPL: an account can carry the person's email address. With single sign-on (EE) that address is what
 * ties the account to the identity provider, and such an account needs no password.
 */
import { useState } from "react";
import { IconPlus } from "@tabler/icons-react";
import { api, apiErrorMessage } from "../../api/client";
import type { UserRow } from "../../api/types";
import { useAuth } from "../../auth/AuthProvider";
import { adminEe } from "../../ee-loader";
import { useInvalidatingMutation, useRoles, useUsers } from "../../hooks/queries";
import { Modal } from "../../components/common/Modal";
import { DataTable } from "../../components/common/DataTable";

const USERNAME_HINT = "lowercase letters, digits, . _ -";
const looksLikeEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());

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
  const SignInCell = adminEe?.UserSignInCell;
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
          { key: "email", title: "Email", sortValue: (u) => u.email ?? "", render: (u) => u.email ?? "—" },
          {
            key: "signin",
            title: "Sign-in",
            render: (u) => (
              <>
                {u.hasPassword && <span className="chip chip-sm">Password</span>}
                {SignInCell && <SignInCell user={u} />}
              </>
            ),
          },
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

/** Edit another account — name, username, email, password reset, roles, active (PUT /api/users/:id) */
function EditUserModal({ user, isSelf, onClose }: { user: UserRow; isSelf: boolean; onClose(): void }) {
  const { data: roles } = useRoles();
  const sso = adminEe?.usePasswordlessAccounts?.() ?? false;
  const SignInSection = adminEe?.UserSignInSection;
  const [form, setForm] = useState({
    name: user.name, username: user.username, email: user.email ?? "", password: "", roleIds: user.roleIds, isActive: user.isActive,
  });
  const [error, setError] = useState<string | null>(null);
  const save = useInvalidatingMutation(
    () => {
      const body: Record<string, unknown> = {
        name: form.name, username: form.username, email: form.email.trim(), roleIds: form.roleIds, isActive: form.isActive,
      };
      if (form.password) body.password = form.password;
      return api(`/api/users/${user.id}`, { method: "PUT", body });
    },
    [["users"]],
  );
  const passwordOk = form.password === "" || form.password.length >= 8;
  const emailOk = form.email.trim() === "" || looksLikeEmail(form.email);
  return (
    <Modal title={`Edit user — ${user.name}`} onClose={onClose}>
      <div className="form-fields">
        <label className="field"><span>Name</span>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label className="field"><span>Username — {USERNAME_HINT}</span>
          <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value.toLowerCase() })} /></label>
        <label className="field">
          <span>{sso ? "Email — the address this person signs in with at your identity provider" : "Email — optional"}</span>
          <input type="email" value={form.email} placeholder="jane@example.com" onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </label>
        <label className="field">
          <span>
            {user.hasPassword
              ? "New temporary password — leave empty to keep (8+ characters; signs the user out, who must change it at next sign-in)"
              : "Password — this account has none (single sign-on only). Enter one (8+ characters) to also allow password sign-in"}
          </span>
          <input type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>
        {SignInSection && <SignInSection user={user} />}
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
          Active — inactive users cannot sign in, and are signed out everywhere
        </label>
        {error && <div className="form-error">{error}</div>}
        <button className="btn btn-primary btn-block"
          disabled={!form.name || !form.username || !passwordOk || !emailOk || save.isPending}
          onClick={() => save.mutate(undefined, { onSuccess: onClose, onError: (e) => setError(apiErrorMessage(e, "failed")) })}>
          Save
        </button>
      </div>
    </Modal>
  );
}

function CreateUserModal({ onClose }: { onClose(): void }) {
  const { data: roles } = useRoles();
  // With single sign-on set up (EE), an email address is enough — no password, and the address can be the username
  const sso = adminEe?.usePasswordlessAccounts?.() ?? false;
  const [form, setForm] = useState({ name: "", username: "", email: "", password: "", roleIds: [] as string[] });
  const [error, setError] = useState<string | null>(null);
  const email = form.email.trim();
  const emailOk = email === "" || looksLikeEmail(email);
  const ssoOnly = sso && email !== "" && emailOk && form.password === "";
  const create = useInvalidatingMutation(
    () => {
      const body: Record<string, unknown> = { name: form.name, username: form.username || email.toLowerCase(), roleIds: form.roleIds };
      if (email) body.email = email;
      if (form.password) body.password = form.password;
      return api("/api/users", { method: "POST", body });
    },
    [["users"]],
  );
  const ready = !!form.name && emailOk && (ssoOnly ? true : !!form.username && form.password.length >= 8);

  return (
    <Modal title="Add user" onClose={onClose}>
      <div className="form-fields">
        <label className="field"><span>Name</span>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label className="field">
          <span>{sso ? "Email — the address this person signs in with at your identity provider" : "Email — optional"}</span>
          <input type="email" value={form.email} placeholder="jane@example.com" onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </label>
        <label className="field">
          <span>Username — {USERNAME_HINT}{sso ? " (leave empty to use the email address)" : ""}</span>
          <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value.toLowerCase() })} placeholder="jane" /></label>
        <label className="field">
          <span>
            {sso
              ? "Temporary password — leave empty if this person signs in with single sign-on only"
              : "Temporary password (8+ characters) — the user must change it at first sign-in"}
          </span>
          <input type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>
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
          disabled={!ready || create.isPending}
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
