
const handler = require("../[...route].js");

module.exports = async function itemHandler(req, res) {
  return handler(req, res);
};
