import { devTokenRequestSchema, ROLES, slugSchema, type Role } from '@canvas/shared';
import { useState, type FormEvent } from 'react';
import { requestDevToken } from '../api/auth-client';
import type { SessionInfo } from '../collab/collab-session';
import { COLLAB_SERVERS } from '../config';
import { colorForUser } from './colors';

const PREFS_KEY = 'collab-canvas:join-form';

interface FormValues {
  displayName: string;
  tenantId: string;
  roomId: string;
  role: Role;
  serverUrl: string;
}

function initialValues(): FormValues {
  const defaults: FormValues = {
    displayName: '',
    tenantId: 'acme',
    roomId: 'design-review',
    role: 'editor',
    serverUrl: COLLAB_SERVERS[0] ?? 'http://localhost:4000',
  };
  let saved: Partial<FormValues> = {};
  try {
    saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<FormValues>;
  } catch {
    // ignore corrupt preferences
  }
  // Deep links look like #tenant/room.
  const [tenantId, roomId] = window.location.hash.slice(1).split('/');
  const values = { ...defaults, ...saved };
  if (tenantId && roomId) Object.assign(values, { tenantId, roomId });
  if (!COLLAB_SERVERS.includes(values.serverUrl)) values.serverUrl = defaults.serverUrl;
  return values;
}

export function JoinScreen({ onJoin }: { onJoin(info: SessionInfo): void }) {
  const [values, setValues] = useState<FormValues>(initialValues);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const set = <K extends keyof FormValues>(key: K, value: FormValues[K]) =>
    setValues((v) => ({ ...v, [key]: value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const request = devTokenRequestSchema.safeParse(values);
    const room = slugSchema.safeParse(values.roomId);
    if (!request.success || !room.success) {
      const issue = request.error?.issues[0] ?? room.error?.issues[0];
      setError(`${issue?.path.join('.') || 'roomId'}: ${issue?.message}`);
      return;
    }
    setPending(true);
    try {
      const { token, expiresAt, user } = await requestDevToken(values.serverUrl, request.data);
      localStorage.setItem(PREFS_KEY, JSON.stringify({ ...values }));
      onJoin({
        serverUrl: values.serverUrl,
        roomId: room.data,
        token,
        expiresAt,
        user,
        color: colorForUser(user.id),
      });
    } catch (err) {
      setError(
        err instanceof TypeError
          ? `Cannot reach ${values.serverUrl}. Is the server running?`
          : (err as Error).message,
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="join">
      <form className="join-card" onSubmit={submit} aria-label="Join a board">
        <h1>Collaborative Canvas</h1>
        <p className="muted">Real-time, offline-capable whiteboard powered by CRDTs.</p>

        <label>
          Your name
          <input
            required
            autoFocus
            maxLength={40}
            value={values.displayName}
            onChange={(e) => set('displayName', e.target.value)}
          />
        </label>
        <div className="row">
          <label>
            Workspace (tenant)
            <input
              required
              value={values.tenantId}
              onChange={(e) => set('tenantId', e.target.value.toLowerCase())}
            />
          </label>
          <label>
            Board
            <input
              required
              value={values.roomId}
              onChange={(e) => set('roomId', e.target.value.toLowerCase())}
            />
          </label>
        </div>
        <div className="row">
          <label>
            Role
            <select value={values.role} onChange={(e) => set('role', e.target.value as Role)}>
              {ROLES.map((role) => (
                <option key={role}>{role}</option>
              ))}
            </select>
          </label>
          <label>
            Server node
            <select value={values.serverUrl} onChange={(e) => set('serverUrl', e.target.value)}>
              {COLLAB_SERVERS.map((url) => (
                <option key={url}>{url}</option>
              ))}
            </select>
          </label>
        </div>

        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button type="submit" disabled={pending}>
          {pending ? 'Joining…' : 'Join board'}
        </button>
      </form>
    </main>
  );
}
