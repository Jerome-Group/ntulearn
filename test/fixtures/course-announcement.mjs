export function courseAnnouncementFixture(options = {}) {
  const state = {
    shown: options.shown !== false,
    close: 0,
    mark: 0,
    gallery: 0,
    routes: 0,
    fallback: 0,
    abort: 0,
  };
  const none = {
    first() {
      return this;
    },
    count: async () => 0,
  };
  const context = {
    serviceWorkers: () => options.workers ?? [],
    async route(pattern, handler) {
      if (options.guardFailure) throw new Error("private guard details");
      state.routes++;
      state.handler = handler;
    },
  };
  const send = async (method = "GET", url = "https://ntulearn.ntu.edu.sg/read") => {
    const request = { method: () => method, url: () => url };
    const route = {
      request: () => request,
      fallback: async () => {
        state.fallback++;
        if (options.fallbackFailure) throw new Error("private network details");
      },
      abort: async () => {
        state.abort++;
        if (options.abortFailure) throw new Error("private abort uncertainty");
      },
    };
    await state.handler(route, request);
  };
  const close = {
    count: async () => options.closeCount ?? 1,
    async click(clickOptions) {
      if (clickOptions?.force) throw new Error("Force prohibited");
      state.close++;
      if (options.closeFailure) throw new Error("private click details");
      if (options.duringClose) await options.duringClose({ send, state, context });
      if (!options.unsettled) state.shown = false;
    },
  };
  const dialog = {
    getByRole(role, { name, exact }) {
      if (!exact) throw new Error("Exact recognition required");
      if (role === "heading" && name === "New Course Announcement")
        return {
          count: async () =>
            options.headingCount ??
            (options.unknown || (options.heading && options.heading !== "New Course Announcement")
              ? 0
              : 1),
        };
      if (role === "button" && name === "Close new announcements modal") return close;
      if (role === "button" && name === "Mark as read") {
        state.mark++;
        throw new Error("Mark as read prohibited");
      }
      return none;
    },
    async waitFor() {
      if (state.shown) throw new Error("Still visible private details");
    },
  };
  const modals = {
    count: async () => (state.shown ? (options.modals ?? 1) : 0),
    nth: () => dialog,
  };
  const trigger = {
    first() {
      return this;
    },
    count: async () => 1,
    click: async () => {
      if (state.shown) throw new Error("intercepts pointer events");
      state.gallery++;
    },
  };
  const frame = {
    locator: () => ({ count: async () => 1 }),
    evaluate: async () => ({
      displayedCount: 1,
      entries: [
        {
          id: "fixture-entry",
          title: "Fixture recording",
          providerReference: "entry:fixture-entry",
          visible: true,
          published: true,
          createdAt: "2026-10-03T00:00:00",
        },
      ],
      hasMore: false,
    }),
    getByRole: () => none,
  };
  const page = {
    goto: async () => {},
    context: () => context,
    locator: (selector) =>
      selector.includes(":visible")
        ? modals
        : selector === "body"
          ? { innerText: async () => "Media Gallery" }
          : none,
    getByRole: () => trigger,
    getByText: () => trigger,
    frames: () => [frame],
  };
  return { page, context, state, send, modals };
}
export const ANNOUNCEMENT_COURSE = {
  key: "fixture",
  courseId: "_fixture_1",
  destination: "/fixture/course",
  mediaMode: "pilot",
};
