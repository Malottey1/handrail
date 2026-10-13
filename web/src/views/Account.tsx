import { useState, type FormEvent } from "react";
import { api, ApiError, type Session, type User } from "../api";

const message = (err: unknown) => (err instanceof ApiError ? err.message : String(err));

/** Your own profile and password. */
export function AccountView({ session, onUserChange }: { session: Session; onUserChange: (u: User) => void }) {
  const { user } = session;
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [profile, setProfile] = useState<{ tone: string; text: string } | null>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [password, setPassword] = useState<{ tone: string; text: string } | null>(null);

  async function saveProfile(e: FormEvent) {
    e.preventDefault();
    try {
      const res = await api<{ user: User }>(session, "/me", { method: "PATCH", body: { name, email } });
      onUserChange(res.user);
      setProfile({ tone: "good", text: "Saved." });
    } catch (err) {
      setProfile({ tone: "bad", text: message(err) });
    }
  }

  async function changePassword(e: FormEvent) {
    e.preventDefault();
    try {
      await api(session, "/me/password", { method: "POST", body: { currentPassword: current, newPassword: next } });
      setCurrent("");
      setNext("");
      setPassword({ tone: "good", text: "Password changed. Other devices have been signed out." });
    } catch (err) {
      setPassword({ tone: "bad", text: message(err) });
    }
  }

  if (user.isDemo) {
    return (
      <section className="card account">
        <h2 className="section-title">Demo account</h2>
        <p>
          You're signed in as <strong>{user.name}</strong>, a shared approver account for trying Handrail on PayPal's sandbox. Its
          name, email and password can't be changed.
        </p>
      </section>
    );
  }

  return (
    <div className="account">
      <section className="card">
        <h2 className="section-title">Profile</h2>
        <p className="section-help">Your name is recorded with every approval and policy change you make.</p>
        <form className="stack-form" onSubmit={saveProfile}>
          <label>
            Name
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} autoComplete="name" />
          </label>
          <label>
            Email
            <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" />
          </label>
          <p className="fine">
            Role: <strong>{user.role}</strong>. Only an admin can change roles.
          </p>
          {profile && <p className={`outcome outcome-${profile.tone}`}>{profile.text}</p>}
          <button className="btn btn-primary" disabled={name.trim() === user.name && email.trim().toLowerCase() === user.email}>
            Save profile
          </button>
        </form>
      </section>

      <section className="card">
        <h2 className="section-title">Password</h2>
        <form className="stack-form" onSubmit={changePassword}>
          <label>
            Current password
            <input className="input" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} required autoComplete="current-password" />
          </label>
          <label>
            New password
            <input
              className="input"
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              required
              minLength={10}
              autoComplete="new-password"
            />
            <span className="field-hint">At least 10 characters.</span>
          </label>
          {password && <p className={`outcome outcome-${password.tone}`}>{password.text}</p>}
          <button className="btn btn-primary" disabled={!current || next.length < 10}>
            Change password
          </button>
        </form>
      </section>
    </div>
  );
}
