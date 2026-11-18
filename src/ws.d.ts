// Minimal declaration: "ws" is only used for the close/error hook in lifecycle.ts.
declare module "ws" {
    const WebSocket: any;
    export default WebSocket;
}
