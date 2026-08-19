// How to talk to Sprout — the AI half of the manual.
//
// HelpModal (shared-ui.jsx) already covers getting around the app: tabs,
// buttons, where things live. This file deliberately covers nothing of that.
// It answers the one question that manual can't: what do I actually TYPE, and
// what happens to my data when I do.
//
// Built as a MODAL, not a view. Three reasons: the bottom bar is full at five
// tabs and this is not a sixth destination; it is a "read once, glance at it
// again in a month" reference, which is exactly what the existing HelpModal
// is; and every example here ends by handing text to the chat composer, so
// floating over chat and closing is the whole interaction — a full view would
// mean a tab swap in the middle of it.
//
// Entry points the orchestrator can wire (this file needs none of them to
// work): Settings, next to "How to use Garden Companion", and the chat empty
// state via GuideEmptyChatHints below.
//
// Loads after shared-ui.jsx (it calls useEscapeKey) and before app.jsx.

// Every phrase below is written the way a user would actually type it, and
// each one maps onto an action Sprout can really perform (see
// ACTION_CONVENTIONS in helpers.jsx — ADD_PLANT / UPDATE_PLANT /
// ADD_TOOL / ADD_ROUTINE / COMPLETE_ROUTINE / ADD_TODO / COMPLETE_TODO /
// ADD_TOGET / ATTACH_PHOTO / SET_COVER). Nothing here is aspirational.
const GUIDE_EXAMPLE_GROUPS = [
  {
    title: "Log what you did",
    icon: "bi-droplet",
    examples: [
      { text: "I watered the tomatoes this morning" },
      { text: "I fertilized the roses yesterday" },
      { text: "I pruned the roses", note: "ticks the matching to-do off" },
    ],
  },
  {
    title: "Add something new",
    icon: "bi-flower3",
    examples: [
      { text: "I planted mint in the balcony pot" },
      { text: "I bought 2 bags of tomato fertilizer" },
    ],
  },
  {
    title: "Reminders and routines",
    icon: "bi-arrow-repeat",
    examples: [
      { text: "Remind me to prune the roses on Saturday", note: "one-off — lands on your to-do list" },
      { text: "Water the basil every 3 days", note: "recurring — lands in Routines" },
    ],
  },
  {
    title: "Shopping list",
    icon: "bi-cart",
    examples: [
      { text: "I need to buy neem oil" },
      { text: "I bought the neem oil", note: "ticks it off and adds it to your supplies" },
    ],
  },
  {
    title: "Ask for help",
    icon: "bi-chat-dots",
    examples: [
      { text: "What should I do in the garden today?" },
      { text: "What's wrong with this plant?", note: "attach a photo before you send" },
      { text: "How often should I water my basil?" },
    ],
  },
];

// The four starters for an empty chat: one question, one log, one reminder,
// one shopping line — so the first tap shows a different kind of thing each
// time, not four flavours of the same one.
const GUIDE_STARTER_HINTS = [
  "What should I do in the garden today?",
  "I watered the tomatoes this morning",
  "Remind me to prune the roses on Saturday",
  "I need to buy neem oil",
];

// What Sprout can change, in the user's words rather than the schema's.
const GUIDE_CAPABILITIES = [
  { icon: "bi-flower3", text: "Plants — add one, log a watering or feeding, edit its location, notes and tags" },
  { icon: "bi-box-seam", text: "Tools and supplies — add what you bought, change quantities, drop what's gone" },
  { icon: "bi-arrow-repeat", text: "Routines — recurring care like “every 3 days”, and ticking them off" },
  { icon: "bi-check2-square", text: "To-dos — one-off tasks with a due date, ticked off when you say they're done" },
  { icon: "bi-cart", text: "To get — your shopping list; say you bought something and it moves into your supplies" },
  { icon: "bi-camera", text: "Photos — put one you sent into a plant's gallery, or make it the cover picture" },
  { icon: "bi-info-circle", text: "Answers — identifies plants, reads a problem off a photo, and looks things up with sources" },
];

const GUIDE_TIPS = [
  "Use the name it's saved under — “Cherry tomato”, not “the red one in the corner”.",
  "Say what changed rather than asking it to work it out: “I watered the tomatoes” beats “the tomatoes are fine now”.",
  "Send a photo for anything you'd have to squint at — spots, pests, wilting, a product label.",
  "One thing at a time when it's complicated. Five edits in one message is where it starts guessing.",
  "If it can't tell which plant you mean it asks instead of guessing — answer with the name and it carries on.",
];

const GUIDE_LIMITS = [
  "It won't invent data. If something isn't saved on this device, it says so instead of making it up.",
  "It won't act on an item that doesn't exist yet — add the plant or tool first, or ask it to.",
  "It can't do anything without the backend: set the VPS URL and client secret in Settings first.",
];

// The guide itself. onNavigate is the app's router — navigate(view, opts);
// { draft } is the same channel garden/inventory/codex/today already use to
// prefill the composer, so an example arrives in the input box ready to send
// (never sent for the user — a photo may still need attaching first).
function GuideView({ onNavigate, onClose }) {
  const close = useCallback(() => {
    if (typeof onClose === "function") onClose();
  }, [onClose]);

  useEscapeKey(close);

  // Not named use* — it runs from a click handler, and a "useX" name here
  // would read as a hook that's being called conditionally.
  function pickExample(text) {
    if (typeof onNavigate === "function") onNavigate("chat", { draft: text });
    close();
  }

  return (
    <div className="modal-backdrop" onClick={close}>
      <div
        className="modal guide-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="guide-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="guide-modal-title">Talking to Sprout</h2>

        <div className="guide-content">
          <p className="guide-lead">
            Sprout is handed a fresh read of your garden with every message, and can change what it
            reads. Tell it what you did and it writes it down; ask it what to do and it answers from
            your actual plants.
          </p>

          <h3>What it can change for you</h3>
          <ul className="guide-caps">
            {GUIDE_CAPABILITIES.map((c) => (
              <li key={c.text}>
                <i className={`bi ${c.icon}`} aria-hidden="true"></i>
                <span>{c.text}</span>
              </li>
            ))}
          </ul>

          <h3>Try one — tap to put it in the chat box</h3>
          {GUIDE_EXAMPLE_GROUPS.map((group) => (
            <div className="guide-group" key={group.title}>
              <p className="guide-group-title">
                <i className={`bi ${group.icon}`} aria-hidden="true"></i> {group.title}
              </p>
              <div className="guide-examples">
                {group.examples.map((ex) => (
                  <button key={ex.text} type="button" className="guide-example" onClick={() => pickExample(ex.text)}>
                    <span className="guide-example-text">
                      {ex.text}
                      {ex.note && <span className="guide-example-note">{ex.note}</span>}
                    </span>
                    <i className="bi bi-chevron-right" aria-hidden="true"></i>
                  </button>
                ))}
              </div>
            </div>
          ))}

          <h3>Getting better answers</h3>
          <ul className="guide-list">
            {GUIDE_TIPS.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>

          <h3>What it won't do</h3>
          <ul className="guide-list">
            {GUIDE_LIMITS.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>

          <p className="hint">
            Anything it changes shows up in the app straight away. Settings &rsaquo; &ldquo;What can
            Sprout see?&rdquo; shows exactly what it is working from right now.
          </p>
        </div>

        <div className="modal-actions">
          <button className="btn" onClick={close}>Close</button>
        </div>
      </div>
    </div>
  );
}

// Starter chips for an EMPTY chat. Independent of the modal above and of the
// rest of the app: give it an onPick and it hands back the phrase (send it,
// or drop it in the composer — the caller decides); give it nothing and it
// still renders, it just doesn't do anything.
function GuideEmptyChatHints({ onPick }) {
  return (
    <div className="guide-hints">
      {GUIDE_STARTER_HINTS.map((text) => (
        <button
          key={text}
          type="button"
          className="followup-chip"
          onClick={() => {
            if (typeof onPick === "function") onPick(text);
          }}
        >
          <i className="bi bi-arrow-return-right" aria-hidden="true"></i> {text}
        </button>
      ))}
    </div>
  );
}
