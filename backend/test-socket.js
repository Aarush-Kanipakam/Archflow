const { io } = require("socket.io-client");
const socket = io("http://localhost:3000/boards", {
  query: { token: "fake-token" } // Wait, fake token will be rejected!
});

socket.on("connect", () => {
  console.log("Connected!");
});
socket.on("disconnect", () => {
  console.log("Disconnected!");
});
