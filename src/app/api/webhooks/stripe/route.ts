import { headers } from "next/headers"
import { db } from "@/db"
import { addresses, carts, orders, payments, products } from "@/db/schema"
import { env } from "@/env.mjs"
import type { CheckoutItem } from "@/types"
import { clerkClient } from "@clerk/nextjs"
import { eq } from "drizzle-orm"
import type Stripe from "stripe"
import { z } from "zod"

import { stripe } from "@/lib/stripe"
import { checkoutItemSchema } from "@/lib/validations/cart"

export async function POST(req: Request) {
  const body = await req.text()
  const signature = headers().get("Stripe-Signature") ?? ""

  let event: Stripe.Event

  try {
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      env.STRIPE_WEBHOOK_SECRET
    )
  } catch (err) {
    return new Response(
      `Webhook Error: ${err instanceof Error ? err.message : "Unknown error."}`,
      { status: 400 }
    )
  }

  switch (event.type) {
    // Handling subscription events
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session

      // If there is a user id, and no cart id in the metadata, then this is a new subscription
      if (session?.metadata?.userId && !session?.metadata?.cartId) {
        // Retrieve the subscription details from Stripe
        const subscription = await stripe.subscriptions.retrieve(
          session.subscription as string
        )

        // Update the user stripe into in our database.
        // Since this is the initial subscription, we need to update
        // the subscription id and customer id.
        await clerkClient.users.updateUserMetadata(session?.metadata?.userId, {
          privateMetadata: {
            stripeSubscriptionId: subscription.id,
            stripeCustomerId: subscription.customer as string,
            stripePriceId: subscription.items.data[0]?.price.id,
            stripeCurrentPeriodEnd: new Date(
              subscription.current_period_end * 1000
            ),
          },
        })
      }
      break
    }
    case "invoice.payment_succeeded": {
      const session = event.data.object as Stripe.Checkout.Session

      // If there is a user id, and no cart id in the metadata, then this is a new subscription
      if (session?.metadata?.userId) {
        // Retrieve the subscription details from Stripe
        const subscription = await stripe.subscriptions.retrieve(
          session.subscription as string
        )

        // Update the price id and set the new period end
        await clerkClient.users.updateUserMetadata(session?.metadata?.userId, {
          privateMetadata: {
            stripePriceId: subscription.items.data[0]?.price.id,
            stripeCurrentPeriodEnd: new Date(
              subscription.current_period_end * 1000
            ),
          },
        })
      }
      break
    }

    // Handling payment events
    case "payment_intent.succeeded": {
      const paymentIntent = event.data.object as Stripe.PaymentIntent

      const paymentIntentId = paymentIntent?.id
      const orderAmount = paymentIntent?.amount
      const checkoutItems = paymentIntent?.metadata
        ?.items as unknown as CheckoutItem[]

      // If there are items in metadata, then create order
      if (checkoutItems) {
        try {
          if (!event.account) throw new Error("No account found.")

          // Parsing items from metadata
          // Didn't parse before because can pass the unparsed data directly to the order table items json column in the db
          const safeParsedItems = z
            .array(checkoutItemSchema)
            .safeParse(JSON.parse(paymentIntent?.metadata?.items ?? "[]"))

          if (!safeParsedItems.success) {
            throw new Error("Could not parse items.")
          }

          const payment = await db.query.payments.findFirst({
            columns: {
              storeId: true,
            },
            where: eq(payments.stripeAccountId, event.account),
          })

          if (!payment?.storeId) {
            return new Response("Store not found.", { status: 404 })
          }

          // Create new address in DB
          const stripeAddress = paymentIntent?.shipping?.address

          const newAddress = await db.insert(addresses).values({
            line1: stripeAddress?.line1,
            line2: stripeAddress?.line2,
            city: stripeAddress?.city,
            state: stripeAddress?.state,
            country: stripeAddress?.country,
            postalCode: stripeAddress?.postal_code,
          })

          if (!newAddress.insertId) throw new Error("No address created.")

          // Parsing user id from metadata which will be used to identify customer in db
          const safeParsedUserId = z
            .string()
            .safeParse(JSON.parse(paymentIntent?.metadata?.userId ?? ""))

          if (!safeParsedUserId.success) {
            throw new Error("Could not parse user id.")
          }

          // Create new order in db
          await db.insert(orders).values({
            storeId: payment.storeId,
            userId: safeParsedUserId.data,
            items: checkoutItems ?? [],
            amount: String(Number(orderAmount) / 100),
            stripePaymentIntentId: paymentIntentId,
            stripePaymentIntentStatus: paymentIntent?.status,
            name: paymentIntent?.shipping?.name,
            email: paymentIntent?.receipt_email,
            addressId: Number(newAddress.insertId),
          })

          // Update product inventory in db
          for (const item of safeParsedItems.data) {
            const product = await db.query.products.findFirst({
              columns: {
                id: true,
                inventory: true,
              },
              where: eq(products.id, item.productId),
            })

            if (!product) {
              throw new Error("Product not found.")
            }

            const inventory = product.inventory - item.quantity

            if (inventory < 0) {
              throw new Error("Product out of stock.")
            }

            await db
              .update(products)
              .set({
                inventory: product.inventory - item.quantity,
              })
              .where(eq(products.id, item.productId))
          }

          // Close cart and clear items
          await db
            .update(carts)
            .set({
              closed: true,
              items: [],
            })
            .where(eq(carts.paymentIntentId, paymentIntentId))
        } catch (err) {
          console.log("Error creating order.", err)
        }
      }
      break
    }
    case "payment_intent.payment_failed": {
      const paymentIntent = event.data.object as Stripe.PaymentIntent
      console.log(
        `❌ Payment failed: ${paymentIntent.last_payment_error?.message}`
      )
      break
    }
    case "payment_intent.processing": {
      const paymentIntent = event.data.object as Stripe.PaymentIntent
      console.log(`⏳ Payment processing: ${paymentIntent.id}`)
      break
    }
    case "charge.succeeded": {
      const charge = event.data.object as Stripe.Charge
      console.log(`Charge id: ${charge.id}`)
      break
    }
    case "application_fee.created": {
      const applicationFee = event.data.object as Stripe.ApplicationFee
      console.log(`Application fee id: ${applicationFee.id}`)
      break
    }
    default: {
      console.warn(`Unhandled event type: ${event.type}`)
      break
    }
  }

  return new Response(null, { status: 200 })
}
