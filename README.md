# ArchFlow AI 📐

ArchFlow AI is a real-time collaborative whiteboard designed specifically for software engineers to sketch, design, and brainstorm system architecture diagrams. 

This project demonstrates a full-stack, real-time architecture utilizing a modern tech stack (Next.js, NestJS, Prisma, WebSockets).

---

## 🏗️ Architecture & Tech Stack

ArchFlow AI is built as a **Monorepo** containing two distinct applications that communicate via REST APIs and WebSockets.

### 1. Frontend (Next.js 15, React 19)
- **Framework:** Next.js (App Router) for routing and server-side rendering.
- **Canvas Engine:** `react-konva` (HTML5 Canvas wrapper) for high-performance rendering of thousands of shapes. We chose canvas over standard HTML `<div>` elements because DOM manipulation becomes extremely slow when users drag hundreds of complex shapes.
- **State Management:** `zustand` for ultra-fast, un-opinionated local state management. The entire board's shapes are stored in a single Zustand store, which allows components to subscribe to changes without triggering full React tree re-renders.
- **Data Fetching:** `@tanstack/react-query` for caching, background updates, and API request deduping. This abstracts away `useEffect` and `useState` for loading/error states.
- **Styling:** Tailwind CSS with a custom, sleek glassmorphism aesthetic.

### 2. Backend (NestJS 11)
- **Framework:** NestJS for a highly opinionated, modular, and scalable enterprise-grade backend architecture based on decorators and dependency injection.
- **Database:** PostgreSQL running locally via Docker Compose.
- **ORM:** Prisma for type-safe database queries and schema migrations. We use UUIDs instead of auto-incrementing integers to prevent ID-guessing attacks and simplify distributed system architecture.
- **Real-Time Engine:** `socket.io` for bi-directional WebSocket communication.

---

## ✨ Features & Deep Dive Implementation

Here is a technical breakdown of how each major feature is implemented in the codebase. This is designed to serve as a deep-dive study guide.

### 1. Authentication & Security (JWT)
The system uses a robust two-token JWT (JSON Web Token) authentication flow to balance security and user experience.
- **Backend (`auth.service.ts`):** Upon login, the server uses `bcrypt` to verify passwords. It generates a short-lived `AccessToken` (expires in 15 mins) and a long-lived `RefreshToken` (expires in 7 days). 
- **Frontend (`axios.ts`):** We built a custom Axios Interceptor. If the frontend attempts an API call and receives a `401 Unauthorized` (meaning the AccessToken expired), the interceptor catches the error. It pauses the original request, hits the `/auth/refresh` endpoint using the `RefreshToken` from LocalStorage, updates the tokens, and automatically replays the original request. To the user, they never get logged out.
- **Guards:** NestJS `JwtAuthGuard` uses the `Passport` strategy to decode the token, ensuring private REST endpoints are secure.

### 2. The Canvas Engine (`react-konva` & `zustand`)
- **Rendering:** The entire whiteboard is rendered inside a `<Stage>` and `<Layer>` component from `react-konva`.
- **Interaction Loop:** When a user clicks and drags a shape (like a `<RectangleShape />`), Konva triggers the `onDragMove` event. This event calls a Zustand setter function, updating the `x` and `y` coordinates of that shape in the global store. React then re-renders only that specific shape at 60fps.
- **Infinite Canvas:** We map the mouse wheel (`onWheel`) to Konva's `stage.scale` and `stage.position`. By using matrix transformations, we can seamlessly zoom in/out at the exact position of the user's cursor.

### 3. Real-Time Collaboration (WebSockets)
ArchFlow uses WebSockets to enable Google Docs-style collaboration.
- **Rooms:** When a user opens a board, the frontend emits a `board:join` event. The NestJS `BoardsGateway` places their socket into a Socket.IO "Room" specific to that board ID. This ensures users only receive WebSocket updates for the board they are currently viewing.
- **Optimistic UI:** When User A drags a shape, the frontend updates their screen immediately (optimistically) so there is zero input lag. Once they release the mouse (`onDragEnd`), the frontend emits a `shape:update` event to the backend. The backend updates the PostgreSQL database via Prisma, then broadcasts that change to the WebSocket room.
- **Rollbacks:** If the server rejects the update (e.g., database constraint failure), it returns an error `ACK`. The frontend catches this and executes a local `undo()` to snap the shape back to its original position.
- **Presence & Live Cursors:** The frontend captures `onMouseMove` over the canvas, throttles the event to prevent network spam, and broadcasts `cursor:move` to the server. Other clients receive the coordinates and render floating cursor components with the user's nametag.

### 4. Role-Based Access Control (RBAC) & Sharing
Boards can be shared with specific permissions (`OWNER`, `EDITOR`, `VIEWER`).
- **Database (`schema.prisma`):** A `BoardMember` junction table maps `User` IDs to `Board` IDs along with an enum `role`.
- **Server Enforcement:** The `boards.service.ts` checks database permissions on every REST request. Furthermore, the WebSocket gateway fetches the user's role during the initial connection handshake. It actively rejects `shape:create`, `shape:update`, and `shape:delete` socket events if the user is a `VIEWER`.
- **Frontend Protection:** The `Whiteboard.tsx` component receives the user's role as a prop. If they are a `VIEWER`, the UI completely disables `draggable` properties on the canvas shapes and hides the editing toolbar, preventing them from even attempting to edit the board.

### 5. Offline Support & Mutation Queues
When a user loses internet connection, they can continue working.
- **Queueing:** The Socket client listens for the `disconnect` event. If triggered, the frontend traps all outgoing `shape:create` and `shape:update` events and pushes the payload into an in-memory `mutationQueue` inside Zustand.
- **Syncing:** Upon the `reconnect` event firing, the frontend loops through the queue and sequentially emits each mutation to the server. We enforce sequential flushing by awaiting the server Acknowledgement (`ACK`) for each event. This prevents race conditions in PostgreSQL.

### 6. Advanced Tools: Undo/Redo & Multi-Select
- **History Stack:** `useCanvasStore.ts` maintains `past` and `future` state arrays. Every time a shape stops moving, a deep clone of the current state is pushed to `past`. Pressing `Ctrl+Z` pops the state from `past`, makes it the current state, and pushes the old state to `future`.
- **Multi-Select:** Users can Shift+Click or drag a Marquee box over multiple shapes. The Konva `<Transformer />` component detects multiple selected nodes and draws a single bounding box around all of them, allowing them to be scaled or moved simultaneously.

---

## 🚀 Upcoming & Future Features

The core engine is built, but the following features are planned for future implementation:

### 1. AI Architecture Generation (OpenAI)
- **Concept:** Users type a prompt like *"Design a Netflix microservice architecture"* and receive a fully editable diagram.
- **Implementation Plan:** We will pass a strict JSON Schema to the OpenAI API using Structured Outputs, forcing the LLM to reply with an array of specific shapes, coordinates, and labels rather than free text. The frontend will receive this JSON array, map it into `CanvasShape` objects, and bulk-insert them into the Zustand store so the user can immediately edit them.

### 2. Auto-Attaching "Smart" Arrows
- **Concept:** When drawing an arrow from a Database shape to a Server shape, the arrow will magnetically snap to the edges.
- **Implementation Plan:** Arrows will store `startShapeId` and `endShapeId` in the database. When a connected shape moves, the canvas engine will dynamically recalculate the shortest distance between the two shapes and update the arrow's points array automatically.

### 3. CRDT & True Offline Merging (Yjs)
- **Concept:** Replacing manual Socket events with a Conflict-Free Replicated Data Type (CRDT) engine.
- **Implementation Plan:** We will migrate the Zustand shape array to a `Y.Doc` (`Y.Map`). We will deploy a `y-websocket` provider. Instead of manual optimistic rollbacks, Yjs will mathematically merge concurrent edits (e.g., if two users edit the exact same text box while offline and both reconnect simultaneously, Yjs flawlessly resolves the conflict without data loss).

### 4. Accessibility (a11y) for Screen Readers
- **Concept:** Making an HTML5 canvas accessible to visually impaired users.
- **Implementation Plan:** We will render a visually hidden, absolute-positioned DOM layer over the canvas that mirrors the shapes. It will use standard HTML elements (like `<button>` or `<div role="img" aria-label="...">`) corresponding to the canvas layout so that screen readers can traverse the diagram logically.
