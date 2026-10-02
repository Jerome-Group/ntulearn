import { downloadRefusal } from "./download.mjs";
import { optionalIsMissing, readRefusal } from "./read.mjs";
import { openSignedInContext } from "./session.mjs";
import { NtulearnReader } from "./reader.mjs";
import { absoluteUrl } from "./urls.mjs";

export async function openClient(profilePath) {
  const { context, token } = await openSignedInContext(profilePath);
  return new NtulearnClient(context, token);
}

// Everything this repository reads out of NTULearn, as the student who is signed in can see it.
class NtulearnClient {
  #context;
  #token;
  #reader;

  constructor(context, token) {
    this.#context = context;
    this.#token = token;
    this.#reader = new NtulearnReader(this.#get.bind(this));
  }

  close() {
    return this.#context.close();
  }

  listCourses() {
    return this.#reader.listCourses();
  }

  readCourse(courseId) {
    return this.#reader.readCourse(courseId);
  }

  readAttachments(courseId, item) {
    return this.#reader.readAttachments(courseId, item);
  }

  async withBrowserPage(read) {
    if (typeof read !== "function") throw new Error("Browser page work needs a reader function.");
    const page = await this.#context.newPage();
    try {
      return await read(page);
    } finally {
      await page.close();
    }
  }

  async download(attachment) {
    const response = await this.#context.request.get(absoluteUrl(attachment.resourceUrl));
    if (!response.ok()) throw new Error(`Download failed: HTTP ${response.status()}`);
    const headers = response.headers();
    const refusal = downloadRefusal({
      attachment,
      url: response.url(),
      contentType: headers["content-type"],
    });
    if (refusal) throw new Error(refusal);
    return { body: await response.body(), headers };
  }

  async #get(path, { optional = false } = {}) {
    const response = await this.#context.request.get(absoluteUrl(path), {
      headers: { Accept: "application/json", "X-Blackboard-XSRF": this.#token },
    });
    const status = response.status();
    if (optional && optionalIsMissing(status)) return { results: [], unavailable: true };
    const refusal = readRefusal({ status, path });
    if (refusal) throw refusal;
    return response.json();
  }
}
