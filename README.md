This repositry create a custom Node-Red node for configing TDEngine server connection and execute SQL from preview node msg.payload
## Design
Use Taos data restful API to commit SQL, API call like

```
curl -H 'Authorization: Basic <TOKEN>' -d '<SQL>' <ip>:<PORT>/rest/sql/[db_name]
```

Input options:
* DB Server: Setup server connection or select a exist server
* DB Name: Database to execute SQL

Use [axios](https://axios-http.com/) to call http request

## Usage

1. Start Node-Red
2. Install TDEngine node
3. Add "taos query" node to workspace from palette 
4. Setup a TDEngine server and database name
5. Add function or other node to create SQL, put SQL into msg.payload
6. Link to "taos query" node

### Demo
1. Start Node-Red by docker

```
docker run -it -p 1880:1880 -v node_red_data:/data --name mynodered nodered/node-red
```

2. Import sample flow "demo/flow.json"

![import-flow](demo/ImportFlow.png)

3. Install TDEngine node by name "node-red-contrib-tdengine", current version is 0.0.2

![alt](demo/InstallTDEngineNode.png)

4. Modify your TDEngine server config

![alt](demo/ModifyServerConfig.png)

5. Edit test SQL

![alt](demo/EditTestSQL.png)

6. Start flow by click Inject node

## Apache IoTDB nodes

This package includes an IoTDB connection node and an IoTDB query node.

1. Follow the package installation instructions above.
2. Add an **IoTDB query** node and create an **IoTDB server** configuration. Set the REST host, port (default `18080`), HTTP or HTTPS, SQL model (`Tree` or `Table`), username, password, request timeout, and maximum query row count.
3. Connect an Inject or Function node. Provide a SQL string in `msg.payload`, an object with a string `msg.payload.sql`, or SQL in the query node's editor. The IoTDB response JSON replaces `msg.payload`.

Tree requests use IoTDB REST v2 (`/rest/v2/query` and `/rest/v2/nonQuery`). Table requests use the Table REST v1 endpoints (`/rest/table/v1/query` and `/rest/table/v1/nonQuery`); the selected database is sent with each request. `SELECT`, `WITH`, `SHOW`, `LIST`, `DESC`, `DESCRIBE`, and `EXPLAIN` statements are sent to the query endpoint. Other statements use the non-query endpoint. Set `msg.iotdb.action` to `query` or `nonQuery` to override that classification.

For Table model requests, set the database in the node or override it with `msg.database` or `msg.iotdb.database`. Tree model uses the fully qualified paths in SQL and does not send a database field. Query requests include the configured row limit. The node reports transport, HTTP, IoTDB status, malformed JSON, and timeout errors through Node-RED's normal error path. The password is stored in Node-RED's encrypted credential store.

Local tests use a temporary HTTP server and require no IoTDB service:

```sh
npm test
```
