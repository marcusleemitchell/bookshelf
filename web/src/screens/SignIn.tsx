/**
 * Sign-in (ADR 0010), shown instead of the app while no one is signed in:
 * first-run setup (name and PIN for the owner), else the profile picker and
 * the chosen profile's PIN.
 */
import { useState } from 'react';
import { pinSchema, type AuthState, type MemberProfile } from '../../../shared/index.ts';
import { useAction, useReachable, useServices } from '../app/hooks.ts';
import { refreshAuth, signedIn } from '../app/services.ts';
import { ActionError, Loading, PinField, ScreenHeader } from '../components/ui.tsx';

export const PIN_RULE = 'A PIN is 4 to 8 digits.';
export const PIN_MISMATCH = 'The two PINs don’t match.';

const isPin = (pin: string) => pinSchema.safeParse(pin).success;

export function SignIn({ state }: { state: AuthState | null }) {
  if (state === null) return <ProfilesUnavailable />;
  if (state.setupRequired) return <SetUp />;
  return <Picker members={state.members} />;
}

function ProfilesUnavailable() {
  const services = useServices();
  const reachable = useReachable();
  if (reachable) return <Loading label="Loading profiles…" />;
  return (
    <>
      <ScreenHeader title="Sign in" />
      <div className="card empty" role="alert">
        <p>The server can’t be reached. Sign in when you’re back online.</p>
        <p>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              void refreshAuth(services);
            }}
          >
            Try again
          </button>
        </p>
      </div>
    </>
  );
}

function SetUp() {
  const services = useServices();
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  return (
    <>
      <ScreenHeader title="Welcome to Bookshelf" />
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          const issue = !isPin(pin) ? PIN_RULE : pin !== confirm ? PIN_MISMATCH : null;
          setProblem(issue);
          if (issue || name.trim() === '') return;
          run(async () => {
            const { member } = await services.api.setUp({ name: name.trim(), pin });
            signedIn(services, member);
          });
        }}
      >
        <p className="muted">
          Choose your name and a PIN. You’ll use the PIN to sign in on each device.
        </p>
        <div className="field">
          <label htmlFor="setup-name">Your name</label>
          <input
            id="setup-name"
            autoComplete="given-name"
            maxLength={50}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </div>
        <PinField
          id="setup-pin"
          label="PIN"
          value={pin}
          onChange={setPin}
          autoComplete="new-password"
        />
        <PinField
          id="setup-confirm"
          label="Confirm PIN"
          value={confirm}
          onChange={setConfirm}
          autoComplete="new-password"
        />
        {problem && (
          <p className="error-text" role="alert">
            {problem}
          </p>
        )}
        <ActionError error={error} />
        <button
          type="submit"
          className="btn btn-primary btn-block"
          disabled={busy || name.trim() === ''}
        >
          {busy ? 'Setting up…' : 'Set up'}
        </button>
      </form>
    </>
  );
}

function Picker({ members }: { members: readonly MemberProfile[] }) {
  const only = members.length === 1 ? (members[0] ?? null) : null;
  const [chosen, setChosen] = useState<MemberProfile | null>(only);
  if (chosen) {
    return (
      <PinEntry
        member={chosen}
        onBack={
          only
            ? null
            : () => {
                setChosen(null);
              }
        }
      />
    );
  }
  return (
    <>
      <ScreenHeader title="Who’s reading?" />
      <ul className="card list" aria-label="Profiles">
        {members.map((member) => (
          <li key={member.id} className="list-item">
            <button
              type="button"
              className="btn btn-ghost btn-block"
              onClick={() => {
                setChosen(member);
              }}
            >
              {member.name}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

function PinEntry({ member, onBack }: { member: MemberProfile; onBack: (() => void) | null }) {
  const services = useServices();
  const [pin, setPin] = useState('');
  const { busy, error, run } = useAction();
  return (
    <>
      <ScreenHeader title={`Hello, ${member.name}`} />
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (!isPin(pin)) return;
          run(async () => {
            try {
              const result = await services.api.signIn({ memberId: member.id, pin });
              signedIn(services, result.member);
            } finally {
              setPin('');
            }
          });
        }}
      >
        <PinField
          id="sign-in-pin"
          label="PIN"
          value={pin}
          onChange={setPin}
          autoComplete="current-password"
        />
        <ActionError error={error} />
        <button type="submit" className="btn btn-primary btn-block" disabled={busy || !isPin(pin)}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        {onBack && (
          <button type="button" className="btn btn-ghost btn-block" onClick={onBack}>
            Someone else
          </button>
        )}
      </form>
    </>
  );
}
