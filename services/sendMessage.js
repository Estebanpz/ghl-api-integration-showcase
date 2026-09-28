import axios from "axios";

const CONFIG = {
    get TOKEN() { return process.env.TOKEN_GHL; },
    get LOCATION_ID() { return process.env.LOCATION_ID; },
};

export async function sendMessage(contactId, message) {
    await crearConversacion(contactId);

    const payload = { contactId, type: "SMS", message };

    try {
        const response = await axios.post(
            'https://services.leadconnectorhq.com/conversations/messages',
            payload,
            {
                headers: {
                    'Authorization': `Bearer ${CONFIG.TOKEN}`,
                    'Content-Type': 'application/json',
                    'Version': '2023-02-21'
                }
            }
        );

        console.log("📨 SMS sent to contact", contactId);
        return response.data;

    } catch (error) {
        const detalle = error.response?.data || { message: error.message };
        console.error("❌ Error enviando SMS:", JSON.stringify(detalle, null, 2));
        throw new Error(`SMS Error ${error.response?.status}: ${JSON.stringify(detalle)}`);
    }
}

async function crearConversacion(contactId) {
    try {
        await axios.post(
            'https://services.leadconnectorhq.com/conversations/',
            { locationId: CONFIG.LOCATION_ID, contactId },
            {
                headers: {
                    'Authorization': `Bearer ${CONFIG.TOKEN}`,
                    'Content-Type': 'application/json',
                    'Version': '2023-02-21'
                }
            }
        );
    } catch (error) {
        if (error.response?.status !== 409) {
            throw error;
        }
    }
}
