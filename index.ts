import index from "./index.html";

const PAPERLESS_URL = process.env.PAPERLESS_URL;
const PAPERLESS_TOKEN = process.env.PAPERLESS_TOKEN;

if (!PAPERLESS_URL || !PAPERLESS_TOKEN) {
  console.error("Missing PAPERLESS_URL / PAPERLESS_TOKEN — set them in .env");
  process.exit(1);
}

async function resolveTaskToDocument(taskId: string): Promise<number | null> {
  const url = `${PAPERLESS_URL}/api/tasks/?task_id=${encodeURIComponent(taskId)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Token ${PAPERLESS_TOKEN}` },
  });
  if (!res.ok) return null;
  const data = await res.json();
  const tasks = Array.isArray(data) ? data : data?.results;
  const task = tasks?.[0];
  if (!task?.related_document) return null;
  const docId = Number(task.related_document);
  return Number.isFinite(docId) ? docId : null;
}

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  routes: {
    "/": index,

    "/api/upload": {
      POST: async (req) => {
        const incoming = await req.formData();
        const file = incoming.get("document");
        if (!(file instanceof File)) {
          return Response.json({ error: "missing 'document' file" }, { status: 400 });
        }

        const out = new FormData();
        out.append("document", file, file.name);
        const title = incoming.get("title");
        if (typeof title === "string") out.append("title", title);

        const t0 = performance.now();
        const upstream = await fetch(`${PAPERLESS_URL}/api/documents/post_document/`, {
          method: "POST",
          headers: { Authorization: `Token ${PAPERLESS_TOKEN}` },
          body: out,
        });
        const body = await upstream.text();
        const ms = Math.round(performance.now() - t0);

        console.log(
          `[upload] ${file.name} → ${upstream.status} (${file.size} B, ${ms} ms)`,
        );

        return new Response(body, {
          status: upstream.status,
          headers: {
            "content-type": upstream.headers.get("content-type") ?? "text/plain",
          },
        });
      },
    },

    "/api/scan/:taskId": {
      DELETE: async (req) => {
        const taskId = req.params.taskId;
        if (!taskId) {
          return Response.json({ error: "missing task id" }, { status: 400 });
        }

        let docId: number | null = null;
        for (let attempt = 0; attempt < 6; attempt++) {
          docId = await resolveTaskToDocument(taskId);
          if (docId) break;
          if (attempt < 5) await Bun.sleep(500);
        }

        if (!docId) {
          return Response.json(
            { error: "document not yet processed by paperless" },
            { status: 409 },
          );
        }

        const upstream = await fetch(`${PAPERLESS_URL}/api/documents/${docId}/`, {
          method: "DELETE",
          headers: { Authorization: `Token ${PAPERLESS_TOKEN}` },
        });

        console.log(`[delete] task=${taskId} doc=${docId} → ${upstream.status}`);

        if (!upstream.ok && upstream.status !== 404) {
          const text = await upstream.text();
          return new Response(text, { status: upstream.status });
        }

        return new Response(null, { status: 204 });
      },
    },
  },
  development: {
    hmr: true,
    console: true,
  },
});

console.log(`quickscan → http://localhost:${server.port}`);
