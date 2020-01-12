const express = require('express')
const router = express.Router()
const consul = require('consul')({
	host: process.env.CONSUL,
	port: 8500
})
const axios = require('axios')
const bodyParser = require('body-parser')
const amqp = require('amqplib/callback_api')

let eventsApi = 'http://localhost:3000/'
let stripe = null
let topic = 'events'

if (process.env.NODE_ENV === 'prod') {
	const eventApiWatcher = consul.watch({
		method: consul.health.service,
		options: {
			service: 'events',
			passing: true
		}
	});

	eventApiWatcher.on('change', data => {
		eventsApi = null

		let entry = data.find(entry => entry.Service.Service === "events")
		if (entry) eventsApi = `http://${entry.Service.Address}:${entry.Service.Port}`
	});

	const stripeSkWatcher = consul.watch({
		method: consul.kv.get,
		options: {key: 'stripe/sk'}
	})

	stripeSkWatcher.on('change', data => {
		stripe = require('stripe')(data.Value);
	});

	const rmqWatcher = consul.watch({
		method: consul.kv.get,
		options: {key: 'rmq/events'}
	})

	rmqWatcher.on('change', data => {
		topic = data.Value
	})

	rmqWatcher.on('error', err => {
		logger.error(err.message)
		lightship.shutdown()
	});
} else {
	stripe = require('stripe')(process.env.STRIPE_SK);
}

let paymentIntent;

router.post('/secret', async (req, res) => {

	if (!stripe) {
		return res.status(503).json('Cannot connect to Stripe!')
	}

	if (!eventsApi) {
		return res.status(503).json('Cannot connect to events!')
	}

	const eventId = req.body.eventId
	const amount = req.body.amount;
	const currency = req.body.currency;

	if (!eventId) {
		return res.status(400).json('Cannot process payment because event id is missing')
	}

	if (!amount) {
		return res.status(400).json('Amount is missing')
	}

	if (!currency) {
		return res.status(400).json('Currency is missing')
	}

	try {
		const data = {
			amount: amount * 100,
			currency: currency,
			metadata: {event_id: eventId},
			payment_method_types: ['card'],
		}

		if (!paymentIntent || paymentIntent.status === 'succeeded' || paymentIntent.status === 'requires_payment_method') {
			paymentIntent = await stripe.paymentIntents.create(data);
		} else {
			await stripe.paymentIntents.update(
				paymentIntent.id,
				data,
			)
		}

		return res.status(200).json({client_secret: paymentIntent.client_secret});
	} catch (err) {
		return res.status(500).json({
			message: err.message,
			paymentIntent: paymentIntent
		})
	}
})

router.post('/webhook', bodyParser.raw({type: 'application/json'}), (request, response) => {
	let event;

	try {
		event = request.body;
	} catch (err) {
		response.status(400).send(`Webhook Error: ${err.message}`);
	}

	// Handle the event
	switch (event.type) {
		case 'payment_intent.succeeded':
			const paymentIntent = event.data.object;
			console.log('PaymentIntent was successful!')
			console.log('Event ID: ' + paymentIntent.metadata.event_id)

			const msg = {status: 'sold', eventId: paymentIntent.metadata.event_id}

			console.log(` [x] Connect to ${process.env.RABBITMQ}`);

			amqp.connect(process.env.RABBITMQ), function (err, conn) {
				if (err) {
					console.log(err.message)
				} else {
					conn.createChannel(function (err1, channel) {
						if (err1) {
							console.log(err1.message)
						} else {
							console.log(` [x] Assert queue ${topic}`);

							channel.assertQueue(topic)
							channel.sendToQueue(queue, Buffer.from(msg))

							console.log(` [x] Sent ${msg}`);
						}
					})
				}
			}

			break
		// ... handle other event types
		default:
			// Unexpected event type
			return response.status(400).end();
	}

	// Return a 200 response to acknowledge receipt of the event
	response.json({received: true});
})

module.exports = router
