const express = require('express')
const app = express()
const port = 8080
const cors = require('cors')

app.use(express.json())
app.use(cors())

const router = require('./routes/billing')
app.use('/', router)

app.listen(port, () => {
	console.log(`Server listening on port ${port}!`)
})
