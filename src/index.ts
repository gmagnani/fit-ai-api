import "dotenv/config";

import Fastify from "fastify";

const fastify = Fastify({
  logger: true,
});

fastify.get("/", function (request, reply) {
  reply.send({ hello: "world" });
});

fastify.listen({ port: Number(process.env.PORT) || 8080 }, function (err) {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
});
