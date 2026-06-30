import express from "express";
import path from "path";
import dotenv from "dotenv";
import { GoogleGenAI, Type } from "@google/genai";
import { createServer as createViteServer } from "vite";

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json());

// Initialize GoogleGenAI client
const apiKey = process.env.GEMINI_API_KEY;
const ai = new GoogleGenAI({
  apiKey: apiKey || "",
  httpOptions: {
    headers: {
      "User-Agent": "aistudio-build",
    },
  },
});

// Helper to check API Key availability
function checkApiKey(res: express.Response) {
  if (!apiKey) {
    res.status(500).json({
      error: "GEMINI_API_KEY environment variable is not configured. Please configure it in Settings > Secrets.",
    });
    return false;
  }
  return true;
}

// Endpoint 1: Generate initial day-by-day plan working backward from the deadline
app.post("/api/generate-plan", async (req, res) => {
  if (!checkApiKey(res)) return;

  const { name, deadline, effort, notes, todayDate, dependencyInfo, busyDates } = req.body;

  if (!name || !deadline || !effort || !todayDate) {
    res.status(400).json({ error: "Missing required fields (name, deadline, effort, todayDate)." });
    return;
  }

  try {
    const depStr = dependencyInfo && dependencyInfo.taskName
      ? `\n      CRITICAL DEPENDENCY CONSTRAINT:
      - This task has a strict prerequisite dependency on another task: "${dependencyInfo.taskName}" (which has a deadline of ${dependencyInfo.deadline} and is currently ${dependencyInfo.completed ? "COMPLETED" : "NOT YET COMPLETED"}).
      - Because of this dependency, the user CANNOT start main execution of "${name}" until the dependency is complete.
      - Therefore, you MUST schedule ONLY very light preparatory, research, or foundational steps for dates BEFORE ${dependencyInfo.deadline} if the dependency is not yet completed. Main implementation steps should only start on or after ${dependencyInfo.deadline} once the prerequisite is done.`
      : "";

    const calendarStr = busyDates && busyDates.length > 0
      ? `\n      CALENDAR CONFLICTS TO AVOID (Read from Google/Outlook Calendar):
      - The user already has busy calendar events scheduled on these dates: ${JSON.stringify(busyDates)}.
      - You MUST avoid scheduling heavy, intense execution steps on these dates to prevent conflicts. If a step must be scheduled on these dates, make it a very light, low-effort task (e.g., "brief check-in", "light read-over", or "quick review").`
      : "";

    const prompt = `
      You are Pacer, an expert AI productivity planner.
      Generate a daily, realistic, action-oriented step-by-step plan to complete the following task before or on the deadline.
      
      Task Details:
      - Task Name: "${name}"
      - Deadline: ${deadline}
      - Plan Start Date: ${todayDate}
      - Effort Size: ${effort} (Small = minor effort needed, Medium = moderate effort, Large = significant complex project)
      - Optional Notes from User: "${notes || "None"}"
      ${depStr}
      ${calendarStr}

      Instructions:
      1. Create exactly one action item (step) for each calendar day starting from ${todayDate} up to and including the deadline date (${deadline}).
      2. The steps MUST work backward from the deadline:
         - The final day (${deadline}) should be for final review, submission, publication, or minor polish.
         - The days leading up to it should build incremental progress.
         - The earlier days should be setting foundations (research, draft, outlines).
      3. Factor in the effort size:
         - Small: Very bite-sized daily steps (15-30 mins/day), or some lighter transition days.
         - Medium: Moderate action steps (1-2 hours/day).
         - Large: Serious deep-work milestones (3+ hours/day).
      4. Make step descriptions extremely concrete, practical, and highly specific to "${name}". Do not use generic placeholders like "Step 1", "Work on project", or "Continue research". Write clear instructions like "Draft the first 3 pages of the intro section" or "Set up database tables and test connections".
      
      Provide your output strictly in JSON format as specified in the schema.
    `;

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            steps: {
              type: Type.ARRAY,
              description: "The chronological daily plan from plan start date to deadline.",
              items: {
                type: Type.OBJECT,
                properties: {
                  date: {
                    type: Type.STRING,
                    description: "The date of the step in YYYY-MM-DD format.",
                  },
                  stepName: {
                    type: Type.STRING,
                    description: "Concrete description of the task for this day.",
                  },
                },
                required: ["date", "stepName"],
              },
            },
          },
          required: ["steps"],
        },
      },
    });

    const data = JSON.parse(response.text?.trim() || "{}");
    res.json(data);
  } catch (error: any) {
    console.error("Error generating plan:", error);
    res.status(500).json({ error: error.message || "Failed to generate plan." });
  }
});

// Endpoint 2: Re-pace / redistribute remaining steps when a day is marked "slipped"
app.post("/api/repace", async (req, res) => {
  if (!checkApiKey(res)) return;

  const { task, skippedStepId, todayDate, dependencyInfo, busyDates } = req.body;

  if (!task || !skippedStepId || !todayDate) {
    res.status(400).json({ error: "Missing required fields (task, skippedStepId, todayDate)." });
    return;
  }

  try {
    const skippedStep = task.steps.find((s: any) => s.id === skippedStepId);
    const completedSteps = task.steps.filter((s: any) => s.status === "completed");
    const remainingSteps = task.steps.filter((s: any) => s.status === "pending" && s.id !== skippedStepId);

    const depStr = dependencyInfo && dependencyInfo.taskName
      ? `\n      CRITICAL DEPENDENCY CONSTRAINT:
      - This task has a strict prerequisite dependency on another task: "${dependencyInfo.taskName}" (which has a deadline of ${dependencyInfo.deadline} and is currently ${dependencyInfo.completed ? "COMPLETED" : "NOT YET COMPLETED"}).
      - Because of this dependency, the user CANNOT start main execution of this task until the dependency is complete.
      - Therefore, you MUST schedule ONLY very light preparatory, research, or foundational steps for dates BEFORE ${dependencyInfo.deadline} if the dependency is not yet completed. Main implementation steps should only start on or after ${dependencyInfo.deadline} once the prerequisite is done.`
      : "";

    const calendarStr = busyDates && busyDates.length > 0
      ? `\n      CALENDAR CONFLICTS TO AVOID (Read from Google/Outlook Calendar):
      - The user already has busy calendar events scheduled on these dates: ${JSON.stringify(busyDates)}.
      - You MUST avoid scheduling heavy, intense execution steps on these dates to prevent conflicts. If a step must be scheduled on these dates, make it a very light, low-effort task (e.g., "brief check-in", "light read-over", or "quick review").`
      : "";

    const prompt = `
      You are Pacer, the AI re-planning engine.
      The user is working on the task "${task.name}" with a hard deadline of ${task.deadline}.
      Today is ${todayDate}.
      
      Unfortunately, the user just fell behind and marked the step for "${skippedStep?.stepName || "today's task"}" as SLIPPED/SKIPPED.
      
      We need to redistribute all the remaining work (including what was skipped/skipped in previous sessions plus all remaining steps) across the remaining calendar days starting from ${todayDate} until the deadline ${task.deadline}.

      Context:
      - Task Name: "${task.name}"
      - Effort Size: ${task.effort}
      - Notes: "${task.notes || "None"}"
      - Completed steps so far: ${JSON.stringify(completedSteps.map((s: any) => ({ date: s.date, stepName: s.stepName })))}
      - What was just skipped: "${skippedStep?.stepName || "No step details"}" on ${skippedStep?.date}
      - Other planned but unfinished steps: ${JSON.stringify(remainingSteps.map((s: any) => ({ date: s.date, stepName: s.stepName })))}
      ${depStr}
      ${calendarStr}

      Instructions:
      1. Create a brand-new plan for the REMAINING dates from ${todayDate} through ${task.deadline} (inclusive).
      2. Redistribute all unfinished work into these remaining days. Do not skip any work; combine or compress tasks if necessary.
      3. If the deadline is extremely close (e.g., today or tomorrow) and the remaining work is too large to fit realistically, set "deadlineAtRisk" to true and provide a helpful, serious, but encouraging explanation in "riskReason". Otherwise, set "deadlineAtRisk" to false.
      4. Make the steps highly concrete, specific, and action-focused.
      
      Provide your output strictly in JSON format as specified in the schema. Do not include past completed steps.
    `;

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            steps: {
              type: Type.ARRAY,
              description: "The updated daily plan for dates from today through the deadline.",
              items: {
                type: Type.OBJECT,
                properties: {
                  date: {
                    type: Type.STRING,
                    description: "The date of the step in YYYY-MM-DD format.",
                  },
                  stepName: {
                    type: Type.STRING,
                    description: "A concrete, redistributed task description for this day.",
                  },
                },
                required: ["date", "stepName"],
              },
            },
            deadlineAtRisk: {
              type: Type.BOOLEAN,
              description: "Whether the remaining work is realistically too dense to finish by the deadline.",
            },
            riskReason: {
              type: Type.STRING,
              description: "If deadlineAtRisk is true, a concise, supportive 1-sentence warning explaining why or what must be cut.",
            },
          },
          required: ["steps", "deadlineAtRisk"],
        },
      },
    });

    const data = JSON.parse(response.text?.trim() || "{}");
    res.json(data);
  } catch (error: any) {
    console.error("Error repacing plan:", error);
    res.status(500).json({ error: error.message || "Failed to repace plan." });
  }
});

// Endpoint 3: Choose the "Most Urgent Today" task with reasons
app.post("/api/analyze-urgency", async (req, res) => {
  if (!checkApiKey(res)) return;

  const { tasks, todayDate } = req.body;

  if (!tasks || !Array.isArray(tasks) || tasks.length === 0) {
    res.json({ taskId: null, reason: "No active tasks today." });
    return;
  }

  try {
    const formattedTasks = tasks.map((t: any) => {
      const todayStep = t.steps.find((s: any) => s.date === todayDate);
      return {
        id: t.id,
        name: t.name,
        deadline: t.deadline,
        effort: t.effort,
        isBehindPace: t.isBehindPace,
        todayStep: todayStep ? todayStep.stepName : "None scheduled",
        progress: `${t.steps.filter((s: any) => s.status === "completed").length}/${t.steps.length} steps completed`,
      };
    });

    const prompt = `
      You are Pacer, the priority strategist.
      Analyze the list of active tasks and their status for today (${todayDate}).
      Select the SINGLE most urgent task that the user should focus on first today, and provide a short, professional, direct one-sentence reason why.

      Active Tasks:
      ${JSON.stringify(formattedTasks, null, 2)}

      Rules for Selection:
      1. Give priority to tasks that:
         - Are closest to their deadline (e.g., due today or in 1-2 days).
         - Have a larger effort size.
         - Are "behind pace" (isBehindPace: true) or have previously slipped steps.
      2. The reason MUST be a single, high-impact, professional, and clear sentence (e.g. "Due in 2 days, and behind pace with 3 remaining high-effort milestones."). Do not use exclamation marks or playful text. Keep it sharp and executive.

      Provide your output strictly in JSON format as specified in the schema.
    `;

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            taskId: {
              type: Type.STRING,
              description: "The ID of the single most urgent task selected.",
            },
            reason: {
              type: Type.STRING,
              description: "A single concise, impactful sentence explaining why this task is the top priority today.",
            },
          },
          required: ["taskId", "reason"],
        },
      },
    });

    const data = JSON.parse(response.text?.trim() || "{}");
    res.json(data);
  } catch (error: any) {
    console.error("Error analyzing urgency:", error);
    res.status(500).json({ error: error.message || "Failed to analyze urgency." });
  }
});

// Vite Middleware Integration
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    // Serve index.html for any remaining route in Express v4
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Pacer Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
