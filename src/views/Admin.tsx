import { useEffect, useState } from "preact/hooks";
import { admin, ApiError } from "../api";
import type {
  AdminAction,
  AdminFeedbackItem,
  AdminLetter,
  AdminMediaItem,
  AdminMember,
  AdminStats,
  AdminRosterEntry,
  AdminSticky,
} from "../../shared/types";
import { Spinner } from "../components/controls";
import { useToast } from "../toast";

type Tab = "stats" | "members" | "cohorts" | "stickies" | "letters" | "feedback" | "media" | "activity";

const TABS: { id: Tab; label: string }[] = [
  { id: "stats", label: "Stats" },
  { id: "members", label: "Members" },
  { id: "cohorts", label: "Cohorts" },
  { id: "stickies", label: "Stickies" },
  { id: "letters", label: "Letters" },
  { id: "feedback", label: "Feedback" },
  { id: "media", label: "Media" },
  { id: "activity", label: "Activity" },
];

function fmt(ts: number | null): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "numeric",
  });
}

/** Two-step confirm for irreversible actions: the first click arms the
 *  button, the second (within a few seconds) actually fires. */
function ConfirmButton({
  label, confirmLabel, onConfirm, danger = true,
}: {
  label: string;
  confirmLabel: string;
  onConfirm: () => Promise<void>;
  danger?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function fire() {
    setBusy(true);
    try {
      await onConfirm();
    } catch (err) {
      toast(err instanceof Error ? err.message : "That didn't work.", "error");
    } finally {
      setBusy(false);
      setArmed(false);
    }
  }

  if (!armed) {
    return (
      <button class={`btn ${danger ? "btn--danger" : ""}`} onClick={() => {
        setArmed(true);
        setTimeout(() => setArmed(false), 5000);
      }}>{label}</button>
    );
  }
  return (
    <button class="btn btn--danger btn--armed" disabled={busy} onClick={fire}>
      {busy ? <Spinner /> : confirmLabel}
    </button>
  );
}

function StatsTab() {
  const toast = useToast();
  const [stats, setStats] = useState<AdminStats | null>(null);
  useEffect(() => {
    admin.stats()
      .then((r) => setStats(r.stats))
      .catch((err) => toast(err instanceof Error ? err.message : "Couldn't load stats.", "error"));
  }, []);
  if (!stats) return <Spinner />;
  const cards: { label: string; value: number; sub?: string }[] = [
    { label: "Members", value: stats.members.total, sub: `${stats.members.active} active, ${stats.members.deactivated} deactivated` },
    { label: "Joined this week", value: stats.members.joinedLast7d, sub: "new accounts, last 7 days" },
    { label: "Profiles", value: stats.roster.profiles, sub: `${stats.roster.mentors} mentors, ${stats.roster.learners} learners` },
    { label: "Sessions", value: stats.roster.sessionAm + stats.roster.sessionPm, sub: `${stats.roster.sessionAm} AM, ${stats.roster.sessionPm} PM` },
    { label: "Stickies", value: stats.stickies.visible, sub: `${stats.stickies.hidden} hidden of ${stats.stickies.total}` },
    { label: "Written this week", value: stats.stickies.last7d, sub: "stickies, last 7 days" },
    { label: "Letters", value: stats.letters.visible, sub: `${stats.letters.hidden} hidden of ${stats.letters.total}` },
    { label: "Unread feedback", value: stats.feedback.unread, sub: `${stats.feedback.total} total` },
    { label: "Media files", value: stats.media.total, sub: "avatars, photos, thumbs" },
  ];
  return (
    <div>
      <div class="group__header">Academy at a glance</div>
      <div class="stat-grid">
        {cards.map((c) => (
          <div class="stat-card" key={c.label}>
            <div class="stat-card__value">{c.value}</div>
            <div class="stat-card__label">{c.label}</div>
            {c.sub && <div class="stat-card__sub">{c.sub}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

function MembersTab() {
  const toast = useToast();
  const [members, setMembers] = useState<AdminMember[] | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [isMentor, setIsMentor] = useState(false);
  const [busy, setBusy] = useState(false);
  const [emailed, setEmailed] = useState<boolean | null>(null);

  async function load() {
    try {
      setMembers((await admin.listMembers()).members);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't load members.", "error");
    }
  }
  useEffect(() => { load(); }, []);

  async function add() {
    if (!name.trim() || !email.trim() || busy) return;
    setBusy(true);
    try {
      const res = await admin.addMember({ name: name.trim(), email: email.trim(), is_mentor: isMentor });
      setEmailed(res.emailed);
      setName(""); setEmail(""); setIsMentor(false);
      toast(res.emailed ? "Member added, sign-in email sent." : "Member added.");
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Couldn't add member.", "error");
    } finally {
      setBusy(false);
    }
  }

  if (!members) return <Spinner />;
  return (
    <div>
      <div class="group__header">Add a member</div>
      <div class="group admin-add">
        <input class="field" placeholder="Name" value={name}
          onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        <input class="field" placeholder="Email" type="email" value={email}
          onInput={(e) => setEmail((e.target as HTMLInputElement).value)} />
        <label class="admin-check">
          <input type="checkbox" checked={isMentor}
            onChange={(e) => setIsMentor((e.target as HTMLInputElement).checked)} />
          Mentor
        </label>
        <button class="btn btn--filled" disabled={busy || !name.trim() || !email.trim()} onClick={add}>
          Add member
        </button>
      </div>
      {emailed === false && (
        <div class="group admin-link">
          Email is not configured, so no sign-in email was sent. A dev can print the
          member's sign-in link with <code>npm run login-link -- --email=&lt;email&gt;</code>.
        </div>
      )}

      <div class="group__header">{members.length} member{members.length === 1 ? "" : "s"}</div>
      <div class="group admin-list">
        {members.map((m) => (
          <MemberRow key={m.id} member={m} onChanged={load} />
        ))}
      </div>
    </div>
  );
}

function MemberRow({ member, onChanged }: { member: AdminMember; onChanged: () => Promise<void> }) {
  const toast = useToast();

  async function toggleMentor() {
    try {
      await admin.updateMember(member.id, { is_mentor: !member.isMentor });
      await onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't update member.", "error");
    }
  }
  async function resend() {
    try {
      const res = await admin.resendLink(member.id);
      if (res.emailed) {
        toast("Sign-in email sent.");
      } else {
        toast("No email configured - a dev can print the link with npm run login-link.", "info");
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't resend link.", "error");
    }
  }

  return (
    <div class="admin-row">
      <div class="admin-row__main">
        <div class="admin-row__title">
          {member.name}
          {member.isAdmin && <span class="admin-tag">admin</span>}
          {member.isMentor && <span class="admin-tag admin-tag--mentor">mentor</span>}
          {member.disabledAt && <span class="admin-tag admin-tag--hidden">deactivated</span>}
        </div>
        <div class="admin-row__sub">
          {member.email} · {member.receivedCount} note{member.receivedCount === 1 ? "" : "s"}
          {member.lastLoginAt ? ` · last sign-in ${fmt(member.lastLoginAt)}` : " · never signed in"}
        </div>
      </div>
      <div class="admin-row__actions">
        <button class="btn" onClick={toggleMentor}>
          {member.isMentor ? "Make learner" : "Make mentor"}
        </button>
        <button class="btn" onClick={resend}>Resend link</button>
        {!member.isAdmin && (
          <>
            <button class="btn" onClick={async () => {
              try {
                if (member.disabledAt) {
                  await admin.enableMember(member.id);
                } else {
                  await admin.disableMember(member.id);
                }
                await onChanged();
              } catch (err) {
                toast(err instanceof Error ? err.message : "Couldn't update member.", "error");
              }
            }}>{member.disabledAt ? "Reactivate" : "Deactivate"}</button>
            <ConfirmButton label="Delete" confirmLabel="Erase their wall + notes forever?"
              onConfirm={async () => { await admin.deleteMember(member.id); await onChanged(); }} />
          </>
        )}
      </div>
    </div>
  );
}

function StickiesTab() {
  const toast = useToast();
  const [stickies, setStickies] = useState<AdminSticky[] | null>(null);

  async function load() {
    try {
      setStickies((await admin.listStickies()).stickies);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't load stickies.", "error");
    }
  }
  useEffect(() => { load(); }, []);

  if (!stickies) return <Spinner />;
  return (
    <div class="group admin-list">
      {stickies.length === 0 && <div class="admin-empty">No stickies yet.</div>}
      {stickies.map((s) => (
        <div class={`admin-row ${s.hiddenAt ? "admin-row--hidden" : ""}`} key={s.id}>
          <div class="admin-row__main">
            <div class="admin-row__title">
              to {s.recipientName} · from {s.isAnonymous ? "anonymous" : (s.authorName ?? "deleted member")}
              {s.hasPhoto && " · photo"}
              {s.hiddenAt && <span class="admin-tag admin-tag--hidden">hidden by {s.hiddenBy ?? "staff"}</span>}
            </div>
            <div class="admin-row__sub">
              {s.describedAs && <>"{s.describedAs}" </>}
              {s.goodAt && <>— {s.goodAt} </>}
              · {fmt(s.createdAt)}
            </div>
          </div>
          <div class="admin-row__actions">
            <button class="btn" onClick={async () => {
              try { await admin.setStickyHidden(s.id, !s.hiddenAt); await load(); }
              catch (err) { toast(err instanceof Error ? err.message : "Couldn't update.", "error"); }
            }}>{s.hiddenAt ? "Restore" : "Hide"}</button>
            <ConfirmButton label="Delete" confirmLabel="Delete permanently?"
              onConfirm={async () => { await admin.deleteSticky(s.id); await load(); }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function LettersTab() {
  const toast = useToast();
  const [letters, setLetters] = useState<AdminLetter[] | null>(null);

  async function load() {
    try {
      setLetters((await admin.listLetters()).letters);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't load letters.", "error");
    }
  }
  useEffect(() => { load(); }, []);

  if (!letters) return <Spinner />;
  return (
    <div class="group admin-list">
      {letters.length === 0 && <div class="admin-empty">No letters yet.</div>}
      {letters.map((l) => (
        <div class={`admin-row ${l.hiddenAt ? "admin-row--hidden" : ""}`} key={l.id}>
          <div class="admin-row__main">
            <div class="admin-row__title">
              "{l.subject || "(no subject)"}" · to {l.recipientName} ·
              from {l.isAnonymous ? "anonymous" : (l.authorName ?? "deleted member")}
              {l.isOpened ? " · opened" : " · sealed"}
              {l.hiddenAt && <span class="admin-tag admin-tag--hidden">hidden by {l.hiddenBy ?? "staff"}</span>}
            </div>
            <div class="admin-row__sub">{l.excerpt}… · {fmt(l.createdAt)}</div>
          </div>
          <div class="admin-row__actions">
            <button class="btn" onClick={async () => {
              try { await admin.setLetterHidden(l.id, !l.hiddenAt); await load(); }
              catch (err) { toast(err instanceof Error ? err.message : "Couldn't update.", "error"); }
            }}>{l.hiddenAt ? "Restore" : "Hide"}</button>
            <ConfirmButton label="Delete" confirmLabel="Delete permanently?"
              onConfirm={async () => { await admin.deleteLetter(l.id); await load(); }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function FeedbackTab() {
  const toast = useToast();
  const [items, setItems] = useState<AdminFeedbackItem[] | null>(null);

  async function load() {
    try {
      setItems((await admin.listFeedback()).feedback);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't load feedback.", "error");
    }
  }
  useEffect(() => { load(); }, []);

  if (!items) return <Spinner />;
  return (
    <div class="group admin-list">
      {items.length === 0 && <div class="admin-empty">No feedback yet.</div>}
      {items.map((f) => (
        <div class={`admin-row ${f.readAt ? "admin-row--hidden" : ""}`} key={f.id}>
          <div class="admin-row__main">
            <div class="admin-row__title">{f.memberName} · {fmt(f.createdAt)}</div>
            <div class="admin-row__sub">{f.message}</div>
          </div>
          <div class="admin-row__actions">
            <button class="btn" onClick={async () => {
              try { await admin.setFeedbackRead(f.id, !f.readAt); await load(); }
              catch (err) { toast(err instanceof Error ? err.message : "Couldn't update.", "error"); }
            }}>{f.readAt ? "Mark unread" : "Mark read"}</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function MediaTab() {
  const toast = useToast();
  const [media, setMedia] = useState<AdminMediaItem[] | null>(null);

  async function load() {
    try {
      setMedia((await admin.listMedia()).media);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't load media.", "error");
    }
  }
  useEffect(() => { load(); }, []);

  if (!media) return <Spinner />;
  return (
    <div class="group admin-list">
      {media.length === 0 && <div class="admin-empty">No uploaded media.</div>}
      {media.map((m) => (
        <div class="admin-row" key={`${m.kind}:${m.key}`}>
          <div class="admin-row__main">
            <div class="admin-row__title">{m.kind} · {m.ownerName}</div>
            <div class="admin-row__sub"><code>{m.key}</code></div>
          </div>
          <div class="admin-row__actions">
            <ConfirmButton label="Delete" confirmLabel="Delete permanently?"
              onConfirm={async () => { await admin.deleteMedia(m.key); await load(); }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function CohortsTab() {
  const toast = useToast();
  const [roster, setRoster] = useState<AdminRosterEntry[] | null>(null);

  async function load() {
    try {
      setRoster((await admin.listRoster()).roster);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't load the roster.", "error");
    }
  }
  useEffect(() => { load(); }, []);

  if (!roster) return <Spinner />;
  return (
    <div>
      <div class="group__header">
        Cohort roster · {roster.filter((r) => r.session === "AM").length} AM ·{" "}
        {roster.filter((r) => r.session === "PM").length} PM ·{" "}
        {roster.filter((r) => !r.session).length} unassigned
      </div>
      <div class="group admin-list">
        {roster.map((r) => (
          <RosterRow key={r.id} entry={r} onChanged={load} />
        ))}
      </div>
    </div>
  );
}

function RosterRow({ entry, onChanged }: { entry: AdminRosterEntry; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const [tagline, setTagline] = useState(entry.tagline ?? "");
  const [role, setRole] = useState(entry.role ?? "");
  const [busy, setBusy] = useState(false);

  async function save(patch: { session?: string | null; tagline?: string | null; role?: string | null }) {
    if (busy) return;
    setBusy(true);
    try {
      await admin.updateRoster(entry.id, patch);
      await onChanged();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Couldn't update the roster.", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="admin-row">
      <div class="admin-row__main">
        <div class="admin-row__title">
          {entry.name}
          {entry.isMentor && <span class="admin-tag admin-tag--mentor">mentor</span>}
          {entry.disabledAt && <span class="admin-tag admin-tag--hidden">deactivated</span>}
          {!entry.hasProfile && <span class="admin-tag admin-tag--hidden">no profile</span>}
        </div>
        <div class="admin-row__sub">
          {entry.slug ?? "no slug"} ·{" "}
          {entry.hasPhoto ? "photo" : "no photo"}
          {entry.hasThumb ? " · thumb" : ""}
        </div>
        <div class="admin-roster-fields">
          <input
            class="field"
            placeholder="Tagline"
            value={tagline}
            maxLength={200}
            onInput={(e) => setTagline((e.target as HTMLInputElement).value)}
          />
          <input
            class="field"
            placeholder={entry.isMentor ? "Role (e.g. Design Mentor)" : "Role"}
            value={role}
            maxLength={120}
            onInput={(e) => setRole((e.target as HTMLInputElement).value)}
          />
        </div>
      </div>
      <div class="admin-row__actions">
        <div class="admin-session">
          {(["AM", "PM", null] as const).map((s) => (
            <button
              key={s ?? "none"}
              class="btn"
              aria-pressed={entry.session === s}
              disabled={busy}
              onClick={() => save({ session: s })}
            >
              {s ?? "No session"}
            </button>
          ))}
        </div>
        <button
          class="btn"
          disabled={busy || (tagline === (entry.tagline ?? "") && role === (entry.role ?? ""))}
          onClick={() => save({ tagline: tagline || null, role: role || null })}
        >
          Save fields
        </button>
      </div>
    </div>
  );
}

function ActivityTab() {
  const toast = useToast();
  const [actions, setActions] = useState<AdminAction[] | null>(null);

  async function load() {
    try {
      setActions((await admin.listActions()).actions);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't load activity.", "error");
    }
  }
  useEffect(() => { load(); }, []);

  if (!actions) return <Spinner />;
  return (
    <div class="group admin-list">
      {actions.length === 0 && <div class="admin-empty">No staff actions yet.</div>}
      {actions.map((a) => (
        <div class="admin-row" key={a.id}>
          <div class="admin-row__main">
            <div class="admin-row__title">{a.action} · {a.adminName}</div>
            <div class="admin-row__sub">
              {a.targetType} {a.targetId}
              {a.detail && ` · ${a.detail}`} · {fmt(a.createdAt)}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function Admin() {
  const [tab, setTab] = useState<Tab>("stats");
  return (
    <div class="admin">
      <div class="admin-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id}
            class={`admin-tab ${tab === t.id ? "admin-tab--active" : ""}`}
            onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === "stats" && <StatsTab />}
      {tab === "members" && <MembersTab />}
      {tab === "cohorts" && <CohortsTab />}
      {tab === "stickies" && <StickiesTab />}
      {tab === "letters" && <LettersTab />}
      {tab === "feedback" && <FeedbackTab />}
      {tab === "media" && <MediaTab />}
      {tab === "activity" && <ActivityTab />}
    </div>
  );
}
