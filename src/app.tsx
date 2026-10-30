import type { JSX } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import type { Me } from "../shared/types";
import { getMe, logout as apiLogout } from "./api";
import { AppFooter } from "./components/AppFooter";
import { HeaderActions } from "./components/HeaderActions";
import { Icon } from "./components/Icon";
import { Nav } from "./components/Nav";
import { Sheet } from "./components/Sheet";
import { Spinner } from "./components/controls";
import { navigate, useHashRoute } from "./router";
import { EditProfile } from "./views/EditProfile";
import { GiveSticky } from "./views/GiveSticky";
import { Login } from "./views/Login";
import { Admin } from "./views/Admin";
import { Mentors } from "./views/Mentors";
import { Roster } from "./views/Roster";
import { SendFeedback } from "./views/SendFeedback";
import { Wall } from "./views/Wall";
import { WriteLetter } from "./views/WriteLetter";

type Theme = "light" | "dark";

function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = localStorage.getItem("theme");
    if (stored === "light" || stored === "dark") return stored;
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((t) => {
      const next = t === "dark" ? "light" : "dark";
      localStorage.setItem("theme", next);
      return next;
    });
  }, []);

  return { theme, toggle };
}

/** Plain anchors so the tabs are real, keyboard-navigable links. */
function DirectoryTabs({ active }: { active: "roster" | "mentors" }) {
  return (
    <nav class="tabs" aria-label="Directory">
      <div class="tabs__inner">
        <a
          class="tabs__tab"
          href="#/"
          aria-current={active === "roster" ? "page" : undefined}
        >
          Learners
        </a>
        <a
          class="tabs__tab"
          href="#/mentors"
          aria-current={active === "mentors" ? "page" : undefined}
        >
          Mentors
        </a>
      </div>
    </nav>
  );
}

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const route = useHashRoute();
  const { theme, toggle } = useTheme();
  const [give, setGive] = useState<{ open: boolean; recipient?: string }>({
    open: false,
  });
  const [letterState, setLetterState] = useState<{ open: boolean; recipient?: string }>({
    open: false,
  });
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    getMe()
      .then(setMe)
      .catch(() => setMe(null));
  }, []);

  // A tab left open won't notice notes that land while it's in the background.
  // Re-reading /me when the page comes back into view refreshes the unread
  // count (and the rest of Me) so the notification dot stays honest without a
  // reload. Only ever upgrades an existing session — never forces a sign-out.
  useEffect(() => {
    function refresh() {
      if (document.visibilityState !== "visible") return;
      getMe()
        .then((m) => m && setMe(m))
        .catch(() => {});
    }
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  const openGive = useCallback((recipient?: string) => {
    setGive({ open: true, recipient });
  }, []);

  const openWriteLetter = useCallback((recipient?: string) => {
    setLetterState({ open: true, recipient });
  }, []);

  const onCreated = useCallback(() => {
    setGive({ open: false });
    setRefresh((r) => r + 1);
  }, []);

  const onLetterCreated = useCallback(() => {
    setLetterState({ open: false });
    setRefresh((r) => r + 1);
  }, []);

  const openFeedback = useCallback(() => setFeedbackOpen(true), []);
  const onFeedbackSent = useCallback(() => setFeedbackOpen(false), []);

  const logout = useCallback(async () => {
    await apiLogout();
    setMe(null);
    navigate("/");
  }, []);

  if (me === undefined) {
    return (
      <div class="center-screen">
        <div class="login-logo">🗒️</div>
        <Spinner />
      </div>
    );
  }

  if (me === null) return <Login />;

  let content: JSX.Element;
  if (route.name === "roster" || route.name === "mentors") {
    const onMentors = route.name === "mentors";
    content = (
      <>
        <Nav
          title="Academy"
          subtitle={onMentors ? "Our mentors" : "Sticky notes between us"}
          right={
            <HeaderActions
              theme={theme}
              onToggleTheme={toggle}
              onLogout={logout}
              unreadCount={me.unreadCount}
              isAdmin={me.isAdmin}
            />
          }
        />
        <DirectoryTabs active={route.name} />
        {onMentors ? (
          <Mentors
            meId={me.id}
            onGive={openGive}
            onWriteLetter={openWriteLetter}
          />
        ) : (
          <Roster
            refreshSignal={refresh}
            onGive={openGive}
            onWriteLetter={openWriteLetter}
          />
        )}
      </>
    );
  } else if (route.name === "admin") {
    content = me.isAdmin ? (
      <>
        <Nav
          title="Academy"
          subtitle="Admin"
          right={
            <HeaderActions
              theme={theme}
              onToggleTheme={toggle}
              onLogout={logout}
              unreadCount={me.unreadCount}
              isAdmin={me.isAdmin}
            />
          }
        />
        <Admin />
      </>
    ) : (
      <Nav title="Academy" subtitle="Not found" />
    );
  } else if (route.name === "edit") {
    content = (
      <EditProfile
        me={me}
        theme={theme}
        onToggleTheme={toggle}
        onMeChange={setMe}
        onSaved={() => {
          setRefresh((r) => r + 1);
          navigate("/me");
        }}
      />
    );
  } else {
    const memberId = route.name === "me" ? me.id : (route.id ?? me.id);
    content = (
      <Wall
        me={me}
        memberId={memberId}
        refreshSignal={refresh}
        onGive={openGive}
        onWriteLetter={openWriteLetter}
        onMeChange={setMe}
        onLogout={logout}
        theme={theme}
        onToggleTheme={toggle}
      />
    );
  }

  return (
    <>
      {content}

      <AppFooter onSendFeedback={openFeedback} />

      {route.name !== "admin" && (
        <div class="fab-group">
          <button class="fab fab--letter" onClick={() => openWriteLetter()} aria-label="Write letter">
            <span aria-hidden="true" style="font-size: 16px;">✉️</span>
            Write Letter
          </button>
          <button class="fab" onClick={() => openGive()} aria-label="New sticky">
            <Icon name="plus" size={20} />
            New Sticky
          </button>
        </div>
      )}

      {give.open && (
        <Sheet title="New Sticky" onClose={() => setGive({ open: false })}>
          <GiveSticky
            me={me}
            prefillRecipientId={give.recipient}
            onCreated={onCreated}
          />
        </Sheet>
      )}

      {letterState.open && (
        <Sheet title="Write Sealed Letter" onClose={() => setLetterState({ open: false })}>
          <WriteLetter
            me={me}
            prefillRecipientId={letterState.recipient}
            onCreated={onLetterCreated}
          />
        </Sheet>
      )}

      {feedbackOpen && (
        <Sheet title="Send Feedback" onClose={() => setFeedbackOpen(false)}>
          <SendFeedback onSent={onFeedbackSent} />
        </Sheet>
      )}
    </>
  );
}
