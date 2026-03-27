import { useState, useRef, useEffect } from "react";

// ─────────────────────────────────────────────
// MULTI-AGENT PIPELINE CONFIGURATION
// Fixed pipeline: Classifier → Agents → Critic → Orchestrator
// ─────────────────────────────────────────────

const MODEL = "claude-sonnet-4-20250514";
const MAX_TOKENS = 900;

const AGENTS = {
  planner:  { label: "📅 Planner",          color: "#4f8ef7" },
  strategy: { label: "🧠 Strategy",          color: "#a259f7" },
  feedback: { label: "📝 Feedback Logger",   color: "#f7a259" },
  analyzer: { label: "📊 Analyzer",          color: "#59c9a5" },
  critic:   { label: "⚙️ Optimizer",         color: "#f75959" },
};

// ─────────────────────────────────────────────
// SYSTEM PROMPTS FOR EACH AGENT
// ─────────────────────────────────────────────

const CLASSIFIER_PROMPT = `You are a routing classifier for an AI study planning system.
Given the student's message, classify which agents should respond.
Reply ONLY with a JSON object like: {"agents": ["planner", "strategy"]}
Valid agents: planner, strategy, feedback, analyzer, critic
Rules:
- Use "planner" when: scheduling, time management, exam prep, weekly/daily plans
- Use "strategy" when: study methods, techniques, how to study a subject
- Use "feedback" when: logging a session, reporting what they studied, how it went
- Use "analyzer" when: asking what is working, patterns, performance review
- Use "critic" when: burnout, plan review, optimization, something isn't working
- Multiple agents may apply. Always pick at least one.`;

const AGENT_PROMPTS = {
  planner: `You are the Planner Agent in a multi-agent AI study planning system.
Your role: Create personalized weekly/daily study schedules.
Input: Student message and conversation history.
Output: Concrete, actionable schedule with time blocks, course names, and session lengths.
Start your response with "📅 Planner Agent:". Keep it under 200 words, be specific and structured.`,

  strategy: `You are the Study Strategy Agent in a multi-agent AI study planning system.
Your role: Recommend and explain evidence-based study methods tailored to the subject.
Methods to draw from: active recall, spaced repetition, Pomodoro technique, flashcards, practice problems, concept mapping, interleaving.
Start your response with "🧠 Strategy Agent:". Explain WHY the method fits this subject. Keep it under 200 words.`,

  feedback: `You are the Feedback & Logging Agent in a multi-agent AI study planning system.
Your role: Extract and log study session data from the student's message.
Log: subject studied, duration, method used, self-reported effectiveness (1-5), mood, notes.
Start your response with "📝 Feedback Logger:". Acknowledge the session warmly and present the logged data in a clear format. Keep it under 150 words.`,

  analyzer: `You are the Performance Analyzer Agent in a multi-agent AI study planning system.
Your role: Analyze patterns in the student's study history from the conversation.
Look for: which methods correlate with high effectiveness, subjects needing more time, trends in mood/burnout.
Start your response with "📊 Analyzer:". Be data-driven. If limited history is available, note that and offer general insights. Keep it under 200 words.`,

  critic: `You are the Critic/Optimizer Agent in a multi-agent AI study planning system.
Your role: Review the student's current approach and suggest concrete improvements.
Focus on: sustainable workload, schedule gaps, method effectiveness, preventing burnout.
Start your response with "⚙️ Optimizer:". Be constructive and specific. Keep it under 200 words.`,
};

const CRITIC_REVIEW_PROMPT = `You are the Critic/Optimizer Agent reviewing a DRAFT response from other agents before it reaches the student.
Your task: Check if the combined agent response is high quality, actionable, and complete.
If it looks good, reply with exactly: APPROVED
If it needs revision, reply with a single improved version that starts with "⚙️ Optimizer:" and merges the best parts.
Keep the revision under 300 words total.`;

const ORCHESTRATOR_PROMPT = `You are the Orchestrator of a multi-agent AI study planning system.
You have received responses from specialist agents. Your job is to:
1. Weave the agent outputs into a single, cohesive, well-formatted reply for the student.
2. Remove any redundancy. Fix any contradiction between agents.
3. Add a brief warm closing line encouraging the student.
Do NOT add new advice — only format and integrate what the agents said.
Preserve the agent labels (📅, 🧠, 📝, 📊, ⚙️) so the student knows who is speaking.`;

// ─────────────────────────────────────────────
// API HELPER
// ─────────────────────────────────────────────

async function callClaude(systemPrompt, messages, userText, syllabus = null, syllabusName = "") {
  const userContent = syllabus
    ? [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: syllabus } },
        { type: "text", text: userText + (syllabusName ? `\n\n[Syllabus uploaded: ${syllabusName}]` : "") },
      ]
    : userText;

  const apiMessages = [
    ...messages.slice(-6).map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: userContent },
  ];

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages: apiMessages,
    }),
  });

  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.content?.map((b) => b.text || "").join("") || "";
}

// ─────────────────────────────────────────────
// MULTI-AGENT PIPELINE
// Step 1: Classify → Step 2: Run agents → Step 3: Critic review → Step 4: Orchestrate
// ─────────────────────────────────────────────

async function runPipeline(userText, history, syllabus, syllabusName, onStep) {
  // STEP 1: Classifier determines which agents to invoke
  onStep("🔍 Routing to the right agents...");
  let agentKeys = ["planner"]; // fallback
  try {
    const classifyResponse = await callClaude(
      CLASSIFIER_PROMPT,
      [],
      userText,
      syllabus,
      syllabusName
    );
    const parsed = JSON.parse(classifyResponse.replace(/```json|```/g, "").trim());
    if (Array.isArray(parsed.agents) && parsed.agents.length > 0) {
      agentKeys = parsed.agents.filter((k) => AGENT_PROMPTS[k]);
    }
  } catch {
    // classifier failed → use simple keyword fallback
    const lower = userText.toLowerCase();
    agentKeys = [];
    if (/schedul|plan|exam|week|hour|time/i.test(lower)) agentKeys.push("planner");
    if (/method|technique|recall|flashcard|pomodoro|how to study/i.test(lower)) agentKeys.push("strategy");
    if (/studied|session|log|spent|felt|effective/i.test(lower)) agentKeys.push("feedback");
    if (/working|pattern|progress|best method|analyz/i.test(lower)) agentKeys.push("analyzer");
    if (/burn|optim|improve|review|sustainable|not working/i.test(lower)) agentKeys.push("critic");
    if (agentKeys.length === 0) agentKeys = ["planner", "strategy"];
  }

  // STEP 2: Run selected agents in parallel
  onStep(`⚡ Running ${agentKeys.map((k) => AGENTS[k]?.label).join(", ")}...`);
  const agentResults = await Promise.all(
    agentKeys.map((key) =>
      callClaude(AGENT_PROMPTS[key], history, userText, syllabus, syllabusName).catch(
        () => `${AGENTS[key]?.label || key}: (Agent unavailable, please try again.)`
      )
    )
  );
  const combinedDraft = agentResults.join("\n\n");

  // STEP 3: Critic reviews the draft
  onStep("🔎 Critic reviewing draft response...");
  let finalDraft = combinedDraft;
  try {
    const criticReview = await callClaude(
      CRITIC_REVIEW_PROMPT,
      [],
      `Student message: "${userText}"\n\nDraft agent responses:\n${combinedDraft}`
    );
    if (!criticReview.trim().toUpperCase().startsWith("APPROVED")) {
      finalDraft = criticReview.trim();
    }
  } catch {
    // critic failed → use draft as-is
  }

  // STEP 4: Orchestrator formats the final reply
  onStep("✨ Orchestrating final response...");
  let reply = finalDraft;
  try {
    const orchestrated = await callClaude(
      ORCHESTRATOR_PROMPT,
      [],
      `Student message: "${userText}"\n\nAgent outputs to integrate:\n${finalDraft}`
    );
    reply = orchestrated.trim() || finalDraft;
  } catch {
    reply = finalDraft;
  }

  return { reply, agentKeys };
}

// ─────────────────────────────────────────────
// UI COMPONENTS
// ─────────────────────────────────────────────

const QUICK_ACTIONS = [
  { label: "📅 Build my study schedule", prompt: "I have exams in 2 weeks. Can you build me a study schedule? I have about 3 hours per day available." },
  { label: "🧠 Recommend study methods", prompt: "What study methods do you recommend for memorizing biology terms and understanding math concepts?" },
  { label: "📝 Log a study session", prompt: "I just studied for 90 minutes. I used flashcards for chemistry and it felt somewhat effective. Can you log this?" },
  { label: "📊 Analyze my progress", prompt: "Based on what I've told you, which study methods seem to be working best for me so far?" },
  { label: "⚙️ Optimize my plan", prompt: "I've been feeling burnt out. Can you review my current approach and suggest ways to make it more sustainable?" },
];

function AgentTag({ agentKeys }) {
  if (!agentKeys || agentKeys.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8 }}>
      {agentKeys.map((k) => {
        const a = AGENTS[k];
        if (!a) return null;
        return (
          <span key={k} style={{
            fontSize: 10, padding: "2px 8px", borderRadius: 20,
            background: a.color + "22", color: a.color,
            border: `1px solid ${a.color}44`, fontWeight: 600,
          }}>{a.label}</span>
        );
      })}
    </div>
  );
}

function Message({ msg }) {
  const isUser = msg.role === "user";
  return (
    <div style={{ display: "flex", justifyContent: isUser ? "flex-end" : "flex-start", marginBottom: 16, gap: 10, alignItems: "flex-start" }}>
      {!isUser && (
        <div style={{ width: 34, height: 34, borderRadius: "50%", background: "linear-gradient(135deg, #4f8ef7, #a259f7)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, flexShrink: 0, marginTop: 2, boxShadow: "0 2px 8px #4f8ef733" }}>🤖</div>
      )}
      <div style={{ maxWidth: "78%" }}>
        {!isUser && msg.agentKeys && <AgentTag agentKeys={msg.agentKeys} />}
        <div style={{
          background: isUser ? "linear-gradient(135deg, #4f8ef7, #6a6ef7)" : "#1e2235",
          color: isUser ? "#fff" : "#e2e8f0",
          borderRadius: isUser ? "18px 18px 4px 18px" : "18px 18px 18px 4px",
          padding: "12px 16px", fontSize: 14, lineHeight: 1.7,
          boxShadow: isUser ? "0 2px 12px #4f8ef733" : "0 2px 8px #00000033",
          border: isUser ? "none" : "1px solid #2d3452",
          whiteSpace: "pre-wrap", wordBreak: "break-word",
        }}>{msg.content}</div>
      </div>
      {isUser && (
        <div style={{ width: 34, height: 34, borderRadius: "50%", background: "#2d3452", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, flexShrink: 0, marginTop: 2, border: "2px solid #4f8ef744" }}>🎓</div>
      )}
    </div>
  );
}

function PipelineIndicator({ step }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
      <div style={{ width: 34, height: 34, borderRadius: "50%", background: "linear-gradient(135deg, #4f8ef7, #a259f7)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>🤖</div>
      <div style={{ background: "#1e2235", border: "1px solid #2d3452", borderRadius: "18px 18px 18px 4px", padding: "10px 16px", color: "#94a3b8", fontSize: 13, fontFamily: "'JetBrains Mono', monospace" }}>
        {step || "Processing..."}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// MAIN APP
// ─────────────────────────────────────────────

export default function StudyPlannerApp() {
  const [messages, setMessages] = useState([
    {
      role: "assistant",
      content: "👋 Hi! I'm your AI Study Planner — a multi-agent system designed to help you study smarter.\n\nThis system uses a 4-step pipeline:\n🔍 Classifier → ⚡ Specialist Agents → 🔎 Critic Review → ✨ Orchestrated Reply\n\nI have 5 specialist agents ready:\n📅 Planner · 🧠 Strategy · 📝 Feedback · 📊 Analyzer · ⚙️ Optimizer\n\nTell me about your courses, upcoming exams, or how studying has been going!",
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [pipelineStep, setPipelineStep] = useState("");
  const [syllabus, setSyllabus] = useState(null);
  const [syllabusName, setSyllabusName] = useState("");
  const bottomRef = useRef(null);
  const fileRef = useRef(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, loading]);

  const handleFileUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setSyllabusName(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => setSyllabus(ev.target.result.split(",")[1]);
    reader.readAsDataURL(file);
  };

  const sendMessage = async (text) => {
    const userText = text || input.trim();
    if (!userText || loading) return;
    setInput("");

    const userMsg = { role: "user", content: userText };
    const newHistory = [...messages, userMsg];
    setMessages(newHistory);
    setLoading(true);
    setPipelineStep("🔍 Routing to the right agents...");

    // History passed to agents (exclude the current user message — we pass it separately)
    const historyForAgents = messages.map((m) => ({ role: m.role, content: m.content }));

    try {
      const { reply, agentKeys } = await runPipeline(
        userText,
        historyForAgents,
        syllabus,
        syllabusName,
        setPipelineStep
      );

      setMessages([...newHistory, { role: "assistant", content: reply, agentKeys }]);
      if (syllabus) setSyllabus(null); // send syllabus only once
    } catch (err) {
      setMessages([...newHistory, {
        role: "assistant",
        content: "⚠️ The pipeline encountered an error. Please check your connection and try again.\n\nError: " + err.message,
      }]);
    }

    setLoading(false);
    setPipelineStep("");
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Sora:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #0d1117; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        ::-webkit-scrollbar { width: 5px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #2d3452; border-radius: 10px; }
        textarea:focus { outline: none; }
        textarea { resize: none; }
      `}</style>

      <div style={{ fontFamily: "'Sora', sans-serif", background: "#0d1117", minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", padding: "0 16px 24px" }}>

        {/* Header */}
        <div style={{ width: "100%", maxWidth: 780, padding: "24px 0 16px", borderBottom: "1px solid #1e2235", marginBottom: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 44, height: 44, borderRadius: 12, background: "linear-gradient(135deg, #4f8ef7, #a259f7)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, boxShadow: "0 4px 16px #4f8ef744" }}>📚</div>
            <div>
              <div style={{ color: "#e2e8f0", fontWeight: 700, fontSize: 18, letterSpacing: -0.3 }}>AI Study Planner</div>
              <div style={{ color: "#4f8ef7", fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }}>Classifier → Agents → Critic → Orchestrator</div>
            </div>
            <div style={{ marginLeft: "auto", display: "flex", gap: 5, flexWrap: "wrap", justifyContent: "flex-end" }}>
              {Object.values(AGENTS).map((a) => (
                <span key={a.label} style={{ fontSize: 10, padding: "3px 8px", borderRadius: 20, background: a.color + "18", color: a.color, border: `1px solid ${a.color}33`, fontWeight: 600, whiteSpace: "nowrap" }}>{a.label}</span>
              ))}
            </div>
          </div>
        </div>

        {/* Chat area */}
        <div style={{ width: "100%", maxWidth: 780, flex: 1, minHeight: 400, maxHeight: "calc(100vh - 350px)", overflowY: "auto", padding: "16px 0", animation: "fadeIn 0.4s ease" }}>
          {messages.map((msg, i) => <Message key={i} msg={msg} />)}
          {loading && <PipelineIndicator step={pipelineStep} />}
          <div ref={bottomRef} />
        </div>

        {/* Quick actions */}
        {messages.length <= 1 && !loading && (
          <div style={{ width: "100%", maxWidth: 780, display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
            {QUICK_ACTIONS.map((a) => (
              <button key={a.label} onClick={() => sendMessage(a.prompt)} style={{ background: "#1e2235", border: "1px solid #2d3452", color: "#94a3b8", borderRadius: 20, padding: "7px 14px", fontSize: 12, cursor: "pointer", fontFamily: "'Sora', sans-serif", transition: "all 0.2s" }}
                onMouseEnter={(e) => { e.target.style.background = "#2d3452"; e.target.style.color = "#e2e8f0"; }}
                onMouseLeave={(e) => { e.target.style.background = "#1e2235"; e.target.style.color = "#94a3b8"; }}
              >{a.label}</button>
            ))}
          </div>
        )}

        {/* Input area */}
        <div style={{ width: "100%", maxWidth: 780, background: "#1e2235", border: "1px solid #2d3452", borderRadius: 16, padding: "12px 14px", boxShadow: "0 4px 24px #00000044" }}>
          {syllabusName && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, padding: "6px 10px", background: "#4f8ef722", borderRadius: 8, color: "#4f8ef7", fontSize: 12 }}>
              📄 <span style={{ flex: 1 }}>{syllabusName}</span>
              <button onClick={() => { setSyllabus(null); setSyllabusName(""); }} style={{ background: "none", border: "none", color: "#94a3b8", cursor: "pointer", fontSize: 14 }}>✕</button>
            </div>
          )}
          <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
            <button onClick={() => fileRef.current?.click()} title="Upload syllabus (PDF)" style={{ background: "#2d3452", border: "1px solid #3d4a6a", borderRadius: 10, width: 38, height: 38, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", fontSize: 16, flexShrink: 0, color: "#94a3b8", transition: "all 0.2s" }}
              onMouseEnter={(e) => e.currentTarget.style.background = "#3d4a6a"}
              onMouseLeave={(e) => e.currentTarget.style.background = "#2d3452"}
            >📎</button>
            <input ref={fileRef} type="file" accept=".pdf" style={{ display: "none" }} onChange={handleFileUpload} />

            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Tell me about your courses, ask for a study plan, or share feedback..."
              rows={1}
              style={{ flex: 1, background: "transparent", border: "none", color: "#e2e8f0", fontSize: 14, fontFamily: "'Sora', sans-serif", lineHeight: 1.6, padding: "8px 0", maxHeight: 120, overflowY: "auto" }}
              onInput={(e) => { e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px"; }}
            />

            <button
              onClick={() => sendMessage()}
              disabled={loading || !input.trim()}
              style={{ background: loading || !input.trim() ? "#2d3452" : "linear-gradient(135deg, #4f8ef7, #a259f7)", border: "none", borderRadius: 10, width: 38, height: 38, display: "flex", alignItems: "center", justifyContent: "center", cursor: loading || !input.trim() ? "not-allowed" : "pointer", fontSize: 16, flexShrink: 0, transition: "all 0.2s", boxShadow: loading || !input.trim() ? "none" : "0 2px 12px #4f8ef755" }}
            >➤</button>
          </div>
          <div style={{ marginTop: 8, color: "#4a5568", fontSize: 11, textAlign: "center" }}>
            Press Enter to send · Shift+Enter for new line · 📎 Upload syllabus PDF
          </div>
        </div>
      </div>
    </>
  );
}
