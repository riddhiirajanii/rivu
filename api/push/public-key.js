const handler = require("../[...route].js");

module.exports = async function pushPublicKey(req, res) {
  return handler(req, res);
};