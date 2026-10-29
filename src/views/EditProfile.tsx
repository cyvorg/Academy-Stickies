import { useEffect, useMemo, useState } from "preact/hooks";
import { PROFILE_LIMITS } from "../../shared/profile";
import type { Me, ProfileLink, ProfileSection } from "../../shared/types";
import { getWall, saveProfile } from "../api";
import { HeaderActions } from "../components/HeaderActions";
import { Icon } from "../components/Icon";
import { Nav } from "../components/Nav";
import { ProfileBody } from "../components/ProfileBody";
import { Spinner } from "../components/controls";
import { navigate } from "../router";
import { useToast } from "../toast";
import { LocationEditor } from "./LocationEditor";

/** Sections and links carry a client-only key so Preact tracks the right row
 *  across reorder and delete; index keys would swap contents under the reader. */
let seq = 0;
const uid = () => `row-${seq++}`;
interface SectionRow extends ProfileSection {
  key: string;
}
interface LinkRow extends ProfileLink {
  key: string;
}

/**
 * The member editing their own profile — name, tagline, intro, free-form
 * sections (add / rename / rewrite / reorder / delete) and links. A live
 * preview renders through the same <ProfileBody> the cohort sees, so what
 * shows here is exactly what lands on the wall. The server sanitizes on save
 * regardless of anything typed here.
 */
export function EditProfile({
  me,
  theme,
  onToggleTheme,
  onMeChange,
  onSaved,
}: {
  me: Me;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onMeChange: (me: Me) => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);

  const [name, setName] = useState(me.name);
  const [tagline, setTagline] = useState("");
  const [intro, setIntro] = useState("");
  const [sections, setSections] = useState<SectionRow[]>([]);
  const [links, setLinks] = useState<LinkRow[]>([]);

  useEffect(() => {
    let live = true;
    getWall(me.id)
      .then((wall) => {
        if (!live) return;
        const p = wall.profile;
        setName(wall.member.name || me.name);
        setTagline(p?.tagline ?? "");
        setIntro(p?.intro ?? "");
        setSections((p?.sections ?? []).map((s) => ({ ...s, key: uid() })));
        setLinks((p?.links ?? []).map((l) => ({ ...l, key: uid() })));
      })
      .catch(() => toast("Couldn't load your profile.", "error"))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [me.id]);

  /** Wrap every setter so any edit marks the form dirty. */
  function touch<T>(setter: (v: T) => void) {
    return (v: T) => {
      setter(v);
      setDirty(true);
    };
  }

  function updateSection(key: string, patch: Partial<ProfileSection>) {
    setSections((rows) =>
      rows.map((r) => (r.key === key ? { ...r, ...patch } : r)),
    );
    setDirty(true);
  }
  function addSection() {
    setSections((rows) => [...rows, { key: uid(), title: "", body: "" }]);
    setDirty(true);
  }
  function removeSection(key: string) {
    setSections((rows) => rows.filter((r) => r.key !== key));
    setDirty(true);
  }
  function moveSection(index: number, dir: -1 | 1) {
    setSections((rows) => {
      const next = index + dir;
      if (next < 0 || next >= rows.length) return rows;
      const copy = rows.slice();
      [copy[index], copy[next]] = [copy[next], copy[index]];
      return copy;
    });
    setDirty(true);
  }

  function updateLink(key: string, patch: Partial<ProfileLink>) {
    setLinks((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
    setDirty(true);
  }
  function addLink() {
    setLinks((rows) => [...rows, { key: uid(), label: "", url: "" }]);
    setDirty(true);
  }
  function removeLink(key: string) {
    setLinks((rows) => rows.filter((r) => r.key !== key));
    setDirty(true);
  }

  const previewSections = useMemo(
    () =>
      sections
        .map(({ title, body }) => ({ title, body }))
        .filter((s) => s.title.trim() || s.body.trim()),
    [sections],
  );
  const previewLinks = useMemo(
    () =>
      links
        .filter((l) => l.url.trim())
        .map(({ label, url }) => ({ label, url })),
    [links],
  );

  const canSave = name.trim().length > 0 && !busy;

  function goBack() {
    if (dirty && !window.confirm("Discard your changes?")) return;
    navigate("/me");
  }

  async function save() {
    if (!canSave) return;
    setBusy(true);
    try {
      const { me: updated } = await saveProfile({
        name: name.trim(),
        tagline: tagline.trim(),
        intro: intro.trim(),
        sections: sections.map(({ title, body }) => ({ title, body })),
        links: links.map(({ label, url }) => ({ label, url })),
      });
      onMeChange(updated);
      setDirty(false);
      toast("Profile saved.");
      onSaved();
    } catch (err) {
      toast(
        err instanceof Error ? err.message : "Couldn't save your profile.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Nav
        title="Edit Profile"
        onBack={goBack}
        right={
          <HeaderActions
            theme={theme}
            onToggleTheme={onToggleTheme}
            unreadCount={me.unreadCount}
          />
        }
      />
      <main class="page">
        {loading ? (
          <div class="center-screen">
            <Spinner />
          </div>
        ) : (
          <div class="editor">
            <div class="group__header">You</div>
            <label class="editor__field">
              <span class="editor__label">Your name</span>
              <input
                class="field"
                value={name}
                maxLength={PROFILE_LIMITS.name}
                onInput={(e) =>
                  touch(setName)((e.currentTarget as HTMLInputElement).value)
                }
              />
            </label>
            <label class="editor__field">
              <span class="editor__label">Tagline</span>
              <input
                class="field"
                placeholder="One line for your roster card"
                value={tagline}
                maxLength={PROFILE_LIMITS.tagline}
                onInput={(e) =>
                  touch(setTagline)((e.currentTarget as HTMLInputElement).value)
                }
              />
            </label>

            <div class="group__header">About you</div>
            <div class="field-wrap">
              <textarea
                class="field field--multiline"
                placeholder="Introduce yourself to the cohort…"
                value={intro}
                maxLength={PROFILE_LIMITS.intro}
                aria-label="About you"
                onInput={(e) =>
                  touch(setIntro)((e.target as HTMLTextAreaElement).value)
                }
              />
              <div class={`field-count ${intro ? "field-count--on" : ""}`}>
                {intro.length}/{PROFILE_LIMITS.intro}
              </div>
            </div>
            <p class="editor__hint">
              Markdown works: **bold**, *italics*, links, and - lists.
            </p>

            <div class="group__header">Your city on the map</div>
            <LocationEditor me={me} onMeChange={onMeChange} />

            <div class="group__header editor__group-head">
              <span>Sections</span>
              <button class="btn btn--plain" onClick={addSection}>
                <Icon name="plus" size={16} /> Add
              </button>
            </div>
            {sections.length === 0 ? (
              <p class="editor__empty">
                No sections yet — add one to give your profile some structure.
              </p>
            ) : (
              sections.map((s, i) => (
                <div class="editor__section" key={s.key}>
                  <div class="editor__section-head">
                    <input
                      class="field editor__section-title"
                      placeholder="Section title"
                      value={s.title}
                      maxLength={PROFILE_LIMITS.sectionTitle}
                      aria-label="Section title"
                      onInput={(e) =>
                        updateSection(s.key, {
                          title: (e.currentTarget as HTMLInputElement).value,
                        })
                      }
                    />
                    <div class="editor__section-tools">
                      <button
                        class="icon-btn"
                        aria-label="Move section up"
                        disabled={i === 0}
                        onClick={() => moveSection(i, -1)}
                      >
                        <Icon name="chevronUp" size={18} />
                      </button>
                      <button
                        class="icon-btn"
                        aria-label="Move section down"
                        disabled={i === sections.length - 1}
                        onClick={() => moveSection(i, 1)}
                      >
                        <Icon name="chevronDown" size={18} />
                      </button>
                      <button
                        class="icon-btn"
                        aria-label="Delete section"
                        onClick={() => removeSection(s.key)}
                      >
                        <Icon name="trash" size={18} />
                      </button>
                    </div>
                  </div>
                  <div class="field-wrap">
                    <textarea
                      class="field field--multiline"
                      placeholder="What goes in this section…"
                      value={s.body}
                      maxLength={PROFILE_LIMITS.sectionBody}
                      aria-label="Section body"
                      onInput={(e) =>
                        updateSection(s.key, {
                          body: (e.target as HTMLTextAreaElement).value,
                        })
                      }
                    />
                    <div class={`field-count ${s.body ? "field-count--on" : ""}`}>
                      {s.body.length}/{PROFILE_LIMITS.sectionBody}
                    </div>
                  </div>
                </div>
              ))
            )}

            <div class="group__header editor__group-head">
              <span>Links</span>
              <button class="btn btn--plain" onClick={addLink}>
                <Icon name="plus" size={16} /> Add
              </button>
            </div>
            {links.length === 0 ? (
              <p class="editor__empty">
                Add a link to your GitHub, LinkedIn, or anywhere else.
              </p>
            ) : (
              links.map((l) => (
                <div class="editor__link-row" key={l.key}>
                  <input
                    class="field editor__link-label"
                    placeholder="Label"
                    value={l.label}
                    maxLength={PROFILE_LIMITS.linkLabel}
                    aria-label="Link label"
                    onInput={(e) =>
                      updateLink(l.key, {
                        label: (e.currentTarget as HTMLInputElement).value,
                      })
                    }
                  />
                  <input
                    class="field editor__link-url"
                    type="url"
                    inputMode="url"
                    placeholder="https://…"
                    value={l.url}
                    maxLength={PROFILE_LIMITS.linkUrl}
                    aria-label="Link URL"
                    onInput={(e) =>
                      updateLink(l.key, {
                        url: (e.currentTarget as HTMLInputElement).value,
                      })
                    }
                  />
                  <button
                    class="icon-btn"
                    aria-label="Remove link"
                    onClick={() => removeLink(l.key)}
                  >
                    <Icon name="trash" size={18} />
                  </button>
                </div>
              ))
            )}

            <div class="group__header">Preview</div>
            <section class="editor__preview">
              <ProfileBody
                intro={intro}
                sections={previewSections}
                links={previewLinks}
              />
            </section>

            <button
              class="btn btn--filled btn--full btn--lg"
              disabled={!canSave}
              onClick={save}
            >
              {busy ? (
                <Spinner />
              ) : (
                <>
                  <Icon name="check" size={18} /> Save profile
                </>
              )}
            </button>
          </div>
        )}
      </main>
    </>
  );
}
