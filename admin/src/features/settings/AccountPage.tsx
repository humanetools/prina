/** My account (P11) — profile and password for the signed-in user */
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../../api/client";
import { useAuth } from "../../auth/AuthProvider";

interface Profile {
  id: string;
  username: string;
  name: string;
  isInstanceAdmin: boolean;
  createdAt: string;
}

export function AccountPage() {
  const qc = useQueryClient();
  const { refresh } = useAuth();
  const { data: me } = useQuery({
    queryKey: ["profile"],
    queryFn: () => api<Profile>("/api/auth/profile"),
  });

  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [profileMsg, setProfileMsg] = useState<string | null>(null);
  const [profileErr, setProfileErr] = useState<string | null>(null);
  const [savingProfile, setSavingProfile] = useState(false);

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pwMsg, setPwMsg] = useState<string | null>(null);
  const [pwErr, setPwErr] = useState<string | null>(null);
  const [savingPw, setSavingPw] = useState(false);

  useEffect(() => {
    if (me) {
      setName(me.name);
      setUsername(me.username);
    }
  }, [me]);

  const dirty = !!me && (name !== me.name || username !== me.username);

  const saveProfile = async () => {
    setSavingProfile(true);
    setProfileErr(null);
    setProfileMsg(null);
    try {
      await api("/api/auth/profile", { method: "PUT", body: { name, username } });
      await qc.invalidateQueries({ queryKey: ["profile"] });
      await refresh(); // Refresh top-bar avatar/name
      setProfileMsg("Profile saved");
    } catch (e) {
      setProfileErr(e instanceof ApiError ? e.message : "Save failed");
    } finally {
      setSavingProfile(false);
    }
  };

  const savePassword = async () => {
    setPwErr(null);
    setPwMsg(null);
    if (next !== confirm) {
      setPwErr("New passwords do not match");
      return;
    }
    setSavingPw(true);
    try {
      await api("/api/auth/password", {
        method: "POST",
        body: { currentPassword: current, newPassword: next },
      });
      setCurrent("");
      setNext("");
      setConfirm("");
      setPwMsg("Password changed · other devices were signed out");
    } catch (e) {
      setPwErr(e instanceof ApiError ? e.message : "Change failed");
    } finally {
      setSavingPw(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>My account</h1>
          <span className="muted">
            Your own name, sign-in ID and password. Roles are managed under Users &amp; Roles.
          </span>
        </div>
      </div>

      <section className="settings-card">
        <div className="panel-title">Profile</div>
        <div className="form-fields narrow" style={{ marginTop: "1.6rem" }}>
          <label className="field">
            <span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            <span>Email — used to sign in</span>
            <input value={username} onChange={(e) => setUsername(e.target.value.toLowerCase())} />
          </label>
          {me?.isInstanceAdmin && (
            <span className="chip chip-sm" style={{ alignSelf: "flex-start" }}>
              Instance admin
            </span>
          )}
          {profileErr && <div className="form-error">{profileErr}</div>}
          <div className="row-gap">
            <button
              className="btn btn-primary"
              disabled={!dirty || savingProfile || !name || !username}
              onClick={() => void saveProfile()}
            >
              {savingProfile ? "Saving…" : "Save profile"}
            </button>
            {profileMsg && <span className="muted">{profileMsg}</span>}
          </div>
        </div>
      </section>

      <section className="settings-card">
        <div className="panel-title">Password</div>
        <p className="widget-hint" style={{ marginTop: "0.8rem" }}>
          Changing your password signs out every other device. This one stays signed in.
        </p>
        <div className="form-fields narrow" style={{ marginTop: "1.6rem" }}>
          <label className="field">
            <span>Current password</span>
            <input
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </label>
          <label className="field">
            <span>New password — 8 characters or more</span>
            <input
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Confirm new password</span>
            <input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </label>
          {pwErr && <div className="form-error">{pwErr}</div>}
          <div className="row-gap">
            <button
              className="btn btn-primary"
              disabled={savingPw || !current || next.length < 8 || !confirm}
              onClick={() => void savePassword()}
            >
              {savingPw ? "Changing…" : "Change password"}
            </button>
            {pwMsg && <span className="muted">{pwMsg}</span>}
          </div>
        </div>
      </section>
    </>
  );
}
