import amqplib, { type ChannelModel, type Channel } from "amqplib";

let connection: ChannelModel | null = null;

export async function connectAmqp(url: string): Promise<ChannelModel> {
  connection = await amqplib.connect(url);
  connection.on("error", (err: Error) => {
    console.error("AMQP connection error:", err.message);
  });
  connection.on("close", () => {
    console.error("AMQP connection closed");
    connection = null;
  });
  return connection;
}

export async function createChannel(conn: ChannelModel): Promise<Channel> {
  const ch = await conn.createChannel();
  await ch.prefetch(1);
  return ch;
}

export async function closeAmqp(): Promise<void> {
  if (connection) {
    await connection.close();
    connection = null;
  }
}
